import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { createMemoryDataStore } from '@smithy-hono/data-core/memory'
import { createMemoryHub } from './memoryHub.js'
import { LIVE_DELETED_TYPE } from './hub.js'
import { withLiveNotify } from './withLiveNotify.js'
import { liveEventStream, createBoundedEventQueue } from './endpoint.js'

/** Read from an SSE ReadableStream until `predicate(accumulated)` or timeout. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  timeoutMs = 1000,
): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate(text)) return text
    const { value, done } = await reader.read()
    if (done) break
    if (value) text += decoder.decode(value, { stream: true })
  }
  if (predicate(text)) return text
  throw new Error(`timed out; got: ${JSON.stringify(text)}`)
}

const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('liveEventStream', () => {
  it('bridges a hub notify to an SSE frame under the concrete event type', async () => {
    const hub = createMemoryHub()
    const app = new Hono()
    app.get('/games/:id/events', (c) =>
      liveEventStream(c, hub, `game:${c.req.param('id')}`, ['game:updated'], {
        heartbeatMs: 0,
      }),
    )

    const res = await app.request('/games/g1/events')
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body!.getReader()

    await tick() // let the subscription attach inside the stream callback
    await hub.notify('game:g1', {
      type: 'game:updated',
      data: { id: 'g1', version: 2 },
    })

    const frame = await readUntil(reader, (t) => t.includes('data:'))
    expect(frame).toContain('event: game:updated')
    expect(frame).toContain('data: {"id":"g1","version":2}')

    await reader.cancel() // aborts the stream → unsubscribe
  })

  it('relabels a polling-style hint (type not in eventTypes) to the primary type', async () => {
    const hub = createMemoryHub()
    const app = new Hono()
    app.get('/e', (c) => liveEventStream(c, hub, 'game:g1', ['game:updated'], { heartbeatMs: 0 }))

    const res = await app.request('/e')
    const reader = res.body!.getReader()
    await tick()
    // Simulate the polling hub's neutral hint type.
    await hub.notify('game:g1', { type: 'live:updated', data: { id: 'game:g1', version: 4 } })

    const frame = await readUntil(reader, (t) => t.includes('data:'))
    expect(frame).toContain('event: game:updated') // relabeled to eventTypes[0]
    expect(frame).toContain('"version":4')

    await reader.cancel()
  })

  it('does not deliver events for a different channel', async () => {
    const hub = createMemoryHub()
    const app = new Hono()
    app.get('/e', (c) => liveEventStream(c, hub, 'game:g1', ['game:updated'], { heartbeatMs: 0 }))

    const res = await app.request('/e')
    const reader = res.body!.getReader()
    await tick()
    await hub.notify('game:OTHER', { type: 'game:updated', data: { version: 9 } })
    await hub.notify('game:g1', { type: 'game:updated', data: { version: 1 } })

    const frame = await readUntil(reader, (t) => t.includes('data:'))
    expect(frame).toContain('"version":1')
    expect(frame).not.toContain('"version":9')

    await reader.cancel()
  })

  // R1-1: a terminal delete is written under its reserved type and closes the
  // stream so the client isn't left hanging on an open connection.
  it('writes a terminal delete frame and then closes the stream', async () => {
    const hub = createMemoryHub()
    const app = new Hono()
    app.get('/e', (c) =>
      liveEventStream(c, hub, 'game:g1', ['game:updated'], { heartbeatMs: 0 }),
    )

    const res = await app.request('/e')
    const reader = res.body!.getReader()
    await tick()
    await hub.notify('game:g1', {
      type: LIVE_DELETED_TYPE,
      data: { id: 'g1', version: null },
    })

    const frame = await readUntil(reader, (t) => t.includes('data:'))
    // Written verbatim under the reserved type — NOT relabeled to game:updated.
    expect(frame).toContain(`event: ${LIVE_DELETED_TYPE}`)
    expect(frame).not.toContain('event: game:updated')

    // The stream closes right after the delete frame.
    const decoder = new TextDecoder()
    let closed = false
    const deadline = Date.now() + 1000
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) {
        closed = true
        break
      }
      // Only ignorable trailing bytes (e.g. the frame tail) should arrive.
      void decoder.decode(value, { stream: true })
    }
    expect(closed).toBe(true)
  })

  // R1-1 end-to-end via withLiveNotify: a committed delete closes a live stream.
  it('closes a live stream when withLiveNotify commits a delete on the channel', async () => {
    interface Game extends Record<string, unknown> {
      id: string
      name: string
    }
    const NO_SCOPE = {}
    const hub = createMemoryHub()
    const store = withLiveNotify(createMemoryDataStore<Game>(), hub, {
      resource: 'game',
      eventType: 'game:updated',
    })
    await store.create('g1', { id: 'g1', name: 'Ada' }, NO_SCOPE)

    const app = new Hono()
    app.get('/e', (c) =>
      liveEventStream(c, hub, 'game:g1', ['game:updated'], { heartbeatMs: 0 }),
    )
    const res = await app.request('/e')
    const reader = res.body!.getReader()
    await tick() // subscription attaches

    await store.delete('g1', undefined, NO_SCOPE) // committed delete → notify

    const frame = await readUntil(reader, (t) => t.includes('data:'))
    expect(frame).toContain(`event: ${LIVE_DELETED_TYPE}`)

    let closed = false
    const deadline = Date.now() + 1000
    while (Date.now() < deadline) {
      const { done } = await reader.read()
      if (done) {
        closed = true
        break
      }
    }
    expect(closed).toBe(true)
  })
})

// R1-3: the per-connection pending-event queue is bounded and coalescing.
describe('createBoundedEventQueue', () => {
  it('coalesces to the latest event per type (bounds a flood to one entry)', () => {
    const q = createBoundedEventQueue()
    for (let v = 1; v <= 1000; v++) {
      q.push({ type: 'game:updated', data: { version: v } })
    }
    // A slow consumer that never drained still sees a queue of exactly 1.
    expect(q.length).toBe(1)
    const only = q.shift()!
    expect((only.data as { version: number }).version).toBe(1000) // latest wins
    expect(q.length).toBe(0)
  })

  it('keeps one entry per distinct type and preserves the latest of each', () => {
    const q = createBoundedEventQueue()
    q.push({ type: 'game:updated', data: { version: 1 } })
    q.push({ type: LIVE_DELETED_TYPE, data: { version: null } })
    q.push({ type: 'game:updated', data: { version: 2 } }) // supersedes v1

    expect(q.length).toBe(2)
    const first = q.shift()!
    const second = q.shift()!
    // The delete is retained (never coalesced away), and the update is the latest.
    const byType = new Map([first, second].map((e) => [e.type, e.data]))
    expect(byType.get(LIVE_DELETED_TYPE)).toEqual({ version: null })
    expect(byType.get('game:updated')).toEqual({ version: 2 })
  })

  it('applies a hard drop-oldest backstop when distinct types exceed the cap', () => {
    const q = createBoundedEventQueue(3)
    for (let i = 0; i < 10; i++) {
      q.push({ type: `t${i}`, data: { i } }) // all distinct types
    }
    expect(q.length).toBe(3) // capped
    // Oldest dropped → the three newest types survive.
    const survivors = [q.shift()!, q.shift()!, q.shift()!].map((e) => e.type)
    expect(survivors).toEqual(['t7', 't8', 't9'])
  })
})
