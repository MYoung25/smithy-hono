/**
 * Tests for the realtime PUSH backend (Phase L4):
 *
 *   - `createDurableObjectHub.notify` routes to `idFromName(channelId)` and POSTs
 *     the serialized event to `/notify` (against a fake namespace).
 *   - `RealtimeDurableObject` fan-out: `/notify` returns 204 and every live SSE
 *     subscriber receives the framed event; unknown path -> 404.
 *   - End-to-end over the SSE contract: a fake namespace mapping channelIds to a
 *     real `RealtimeDurableObject` proves `notify` + the port-uniform `subscribe`
 *     bridge deliver events into the in-isolate `onEvent` callback.
 *   - `forwardLiveSubscribe` hands back the DO's streaming Response directly.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  RealtimeDurableObject,
  createDurableObjectHub,
  forwardLiveSubscribe,
  REALTIME_DO_PATHS,
  SSE_HEARTBEAT_MS,
  SSE_MAX_BUFFERED_BYTES,
  SSE_RESUBSCRIBE_DELAY_MS,
  type RealtimeEvent,
} from './realtimeDurableObject.js'
import type { DurableObjectNamespaceLike } from './securityStores.js'
import type { DurableObjectStubLike } from './realPorts.js'

const ORIGIN = 'https://realtime-hub.internal'

/** Read exactly one `data:` SSE frame's JSON payload off a Response body. */
async function readOneEvent(res: Response): Promise<RealtimeEvent> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) throw new Error('stream ended before a data frame arrived')
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'))
      if (dataLine) {
        void reader.cancel()
        return JSON.parse(dataLine.slice('data:'.length).trim()) as RealtimeEvent
      }
    }
  }
}

describe('createDurableObjectHub.notify — routing + body', () => {
  it('routes idFromName(channelId) and POSTs the event JSON to /notify', async () => {
    const calls: { name: string; request: Request }[] = []
    let lastGet: unknown
    const ns: DurableObjectNamespaceLike = {
      idFromName: (name) => ({ name }),
      get: (id) => {
        lastGet = id
        const name = (id as { name: string }).name
        return {
          fetch: async (request: Request) => {
            calls.push({ name, request })
            return new Response(null, { status: 204 })
          },
        }
      },
    }

    const hub = createDurableObjectHub(ns)
    const event: RealtimeEvent = { type: 'game:updated', data: { id: 'g1', version: 7 } }
    await hub.notify('game:g1', event)

    expect(calls).toHaveLength(1)
    expect((lastGet as { name: string }).name).toBe('game:g1') // idFromName seed
    const { name, request } = calls[0]
    expect(name).toBe('game:g1')
    expect(request.method).toBe('POST')
    expect(new URL(request.url).pathname).toBe(REALTIME_DO_PATHS.notify)
    expect(await request.json()).toEqual(event)
  })

  it('swallows errors — notify is best-effort and never throws', async () => {
    const ns: DurableObjectNamespaceLike = {
      idFromName: (name) => name,
      get: () => ({
        fetch: async () => {
          throw new Error('DO unreachable')
        },
      }),
    }
    const hub = createDurableObjectHub(ns)
    await expect(hub.notify('game:g1', { type: 't', data: 1 })).resolves.toBeUndefined()
  })
})

describe('RealtimeDurableObject — fetch dispatch + fan-out', () => {
  it('POST /notify returns 204 and fans the event to every SSE subscriber', async () => {
    const room = new RealtimeDurableObject()

    // Two subscribers attach over SSE.
    const subA = await room.fetch(new Request(ORIGIN + REALTIME_DO_PATHS.subscribe))
    const subB = await room.fetch(new Request(ORIGIN + REALTIME_DO_PATHS.subscribe))
    expect(subA.status).toBe(200)
    expect(subA.headers.get('content-type')).toBe('text/event-stream')

    const event: RealtimeEvent = { type: 'game:updated', data: { id: 'g1', version: 3 } }
    const notify = await room.fetch(
      new Request(ORIGIN + REALTIME_DO_PATHS.notify, {
        method: 'POST',
        body: JSON.stringify(event),
      }),
    )
    expect(notify.status).toBe(204)

    // Both live subscribers receive the same framed event.
    expect(await readOneEvent(subA)).toEqual(event)
    expect(await readOneEvent(subB)).toEqual(event)
  })

  it('notify with no subscribers still acks 204 (no-op fan-out)', async () => {
    const room = new RealtimeDurableObject()
    const res = await room.fetch(
      new Request(ORIGIN + REALTIME_DO_PATHS.notify, {
        method: 'POST',
        body: JSON.stringify({ type: 't', data: null }),
      }),
    )
    expect(res.status).toBe(204)
  })

  it('returns 404 for an unknown path', async () => {
    const room = new RealtimeDurableObject()
    const res = await room.fetch(new Request(ORIGIN + '/nope', { method: 'POST' }))
    expect(res.status).toBe(404)
  })

  it('falls back to SSE (not a WS upgrade) when the runtime has no hibernation', async () => {
    // Constructed with no hibernation-capable ctx: an Upgrade header must NOT
    // yield a 101; it degrades to the SSE stream.
    const room = new RealtimeDurableObject()
    const res = await room.fetch(
      new Request(ORIGIN + REALTIME_DO_PATHS.subscribe, {
        headers: { Upgrade: 'websocket' },
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    void res.body!.cancel()
  })
})

describe('end-to-end over the SSE contract (hub.notify + hub.subscribe bridge)', () => {
  /** A fake namespace mapping each channelId to its own real RealtimeDurableObject. */
  function namespaceOverRealDOs(): DurableObjectNamespaceLike {
    const rooms = new Map<string, RealtimeDurableObject>()
    const roomFor = (channelId: string) => {
      let room = rooms.get(channelId)
      if (!room) {
        room = new RealtimeDurableObject()
        rooms.set(channelId, room)
      }
      return room
    }
    return {
      idFromName: (name) => name, // opaque channelId is its own id here
      get: (id): DurableObjectStubLike => {
        const room = roomFor(id as string)
        return { fetch: (request: Request) => room.fetch(request) }
      },
    }
  }

  it('delivers a notified event to a bridged subscriber via onEvent', async () => {
    const hub = createDurableObjectHub(namespaceOverRealDOs())
    const received: RealtimeEvent[] = []

    const unsubscribe = hub.subscribe('game:g1', (e) => received.push(e))
    // Give the internal SSE stream a tick to open before we publish.
    await new Promise((r) => setTimeout(r, 10))

    const event: RealtimeEvent = { type: 'game:updated', data: { id: 'g1', version: 9 } }
    await hub.notify('game:g1', event)

    await waitFor(() => received.length === 1)
    expect(received[0]).toEqual(event)

    // A different channel's notify is not delivered to this subscriber.
    await hub.notify('game:other', { type: 'game:updated', data: { id: 'other', version: 1 } })
    await new Promise((r) => setTimeout(r, 10))
    expect(received).toHaveLength(1)

    unsubscribe()
  })
})

describe('forwardLiveSubscribe — direct-forward wiring', () => {
  it('returns the DO stream Response directly (DO owns the connection)', async () => {
    const room = new RealtimeDurableObject()
    const ns: DurableObjectNamespaceLike = {
      idFromName: (name) => name,
      get: (): DurableObjectStubLike => ({ fetch: (request) => room.fetch(request) }),
    }
    const clientReq = new Request('https://api.example.com/games/g1/events')
    const res = await forwardLiveSubscribe(ns, 'game:g1', clientReq)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    void res.body!.cancel()
  })
})

describe('R3-2 — server-side heartbeat on the DO SSE leg', () => {
  it('emits a periodic `: heartbeat` comment so an idle DO→Worker leg stays alive', async () => {
    vi.useFakeTimers()
    try {
      const room = new RealtimeDurableObject()
      const res = await room.fetch(new Request(ORIGIN + REALTIME_DO_PATHS.subscribe))
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()

      // The stream opens with the `: connected` comment.
      const first = await reader.read()
      expect(decoder.decode(first.value)).toContain(': connected')

      // Advancing one interval must flush a `: heartbeat` comment frame — with no
      // notify in between, proving the DO's own liveness heartbeat (not a data push).
      vi.advanceTimersByTime(SSE_HEARTBEAT_MS)
      const beat = await reader.read()
      expect(decoder.decode(beat.value)).toContain(': heartbeat')

      void reader.cancel()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the heartbeat interval on cancel (no enqueue onto a closed stream)', async () => {
    vi.useFakeTimers()
    try {
      const clearSpy = vi.spyOn(globalThis, 'clearInterval')
      const room = new RealtimeDurableObject()
      const res = await room.fetch(new Request(ORIGIN + REALTIME_DO_PATHS.subscribe))
      const before = clearSpy.mock.calls.length
      await res.body!.cancel()
      expect(clearSpy.mock.calls.length).toBeGreaterThan(before)
      clearSpy.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('R3-3 — wedged (non-reading) SSE consumer is evicted past the byte bound', () => {
  it('closes + drops a subscriber whose unread buffer exceeds SSE_MAX_BUFFERED_BYTES', async () => {
    const room = new RealtimeDurableObject()
    const res = await room.fetch(new Request(ORIGIN + REALTIME_DO_PATHS.subscribe))
    // Hold the body but NEVER read it → a half-open, wedged consumer.
    const reader = res.body!.getReader()

    // Each notify enqueues a ~1/3-bound frame; a non-reading consumer accumulates
    // them until the buffer crosses the bound and the DO evicts it.
    const filler = 'x'.repeat(Math.ceil(SSE_MAX_BUFFERED_BYTES / 3))
    const big = JSON.stringify({ type: 'game:updated', data: filler })
    for (let i = 0; i < 5; i++) {
      const ack = await room.fetch(
        new Request(ORIGIN + REALTIME_DO_PATHS.notify, { method: 'POST', body: big }),
      )
      expect(ack.status).toBe(204)
    }

    // A notify AFTER eviction must not reach this (now-dropped) subscriber.
    await room.fetch(
      new Request(ORIGIN + REALTIME_DO_PATHS.notify, {
        method: 'POST',
        body: JSON.stringify({ type: 'game:updated', data: 'AFTER_EVICTION' }),
      }),
    )

    // Because the DO closed the wedged stream, draining now TERMINATES (done)
    // rather than hanging forever, and the post-eviction event is absent.
    const decoder = new TextDecoder()
    let text = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) text += decoder.decode(value, { stream: true })
    }
    expect(text).not.toContain('AFTER_EVICTION')
  })

  it('does NOT evict a healthy consumer that keeps reading', async () => {
    const room = new RealtimeDurableObject()
    const res = await room.fetch(new Request(ORIGIN + REALTIME_DO_PATHS.subscribe))
    const event: RealtimeEvent = { type: 'game:updated', data: { id: 'g1', version: 1 } }
    await room.fetch(
      new Request(ORIGIN + REALTIME_DO_PATHS.notify, { method: 'POST', body: JSON.stringify(event) }),
    )
    // A reading consumer still receives the event (proves the bound guard doesn't
    // evict healthy subscribers) and the stream stays open for the next notify.
    expect(await readOneEvent(res)).toEqual(event)
  })
})

describe('R3-2 — SSE bridge resilience (re-subscribe vs. silent drop)', () => {
  /** A namespace whose DO SSE stream dies on the first pass, then delivers. */
  function flakyThenDeliveringNamespace(counter: { subscribes: number }): DurableObjectNamespaceLike {
    const enc = new TextEncoder()
    const stub: DurableObjectStubLike = {
      fetch: async (request: Request): Promise<Response> => {
        const path = new URL(request.url).pathname
        if (path !== REALTIME_DO_PATHS.subscribe) return new Response(null, { status: 204 })
        counter.subscribes += 1
        const attempt = counter.subscribes
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(enc.encode(': connected\n\n'))
            if (attempt === 1) {
              // First DO leg ends UNEXPECTEDLY (eviction/restart/idle drop).
              controller.close()
            } else {
              // The re-subscribed leg delivers the event that was "in flight".
              controller.enqueue(
                enc.encode('data: ' + JSON.stringify({ type: 'game:updated', data: { v: 1 } }) + '\n\n'),
              )
              // Stays open otherwise.
            }
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    }
    return { idFromName: (name) => name, get: () => stub }
  }

  it('re-subscribes when the DO stream ends unexpectedly — no silent event drop', async () => {
    const counter = { subscribes: 0 }
    const hub = createDurableObjectHub(flakyThenDeliveringNamespace(counter))
    const received: RealtimeEvent[] = []
    const unsubscribe = hub.subscribe('game:g1', (e) => received.push(e))

    // The first leg died with nothing delivered; the bridge must reconnect and
    // then deliver — a naive pump would strand the client leg with zero events.
    await waitFor(() => received.length === 1, 3000)
    expect(counter.subscribes).toBeGreaterThanOrEqual(2)
    expect(received[0]).toEqual({ type: 'game:updated', data: { v: 1 } })

    unsubscribe()
  })

  it('intentional unsubscribe tears down cleanly and does NOT reconnect', async () => {
    const enc = new TextEncoder()
    let subscribes = 0
    const stub: DurableObjectStubLike = {
      fetch: async (request: Request): Promise<Response> => {
        const path = new URL(request.url).pathname
        if (path !== REALTIME_DO_PATHS.subscribe) return new Response(null, { status: 204 })
        subscribes += 1
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(enc.encode(': connected\n\n'))
            // Stays open — only an abort ends it.
          },
        })
        // Model a real Worker→DO fetch: aborting the request cancels the source.
        const body =
          request.signal && stream
            ? stream.pipeThrough(new TransformStream(), { signal: request.signal })
            : stream
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    }
    const ns: DurableObjectNamespaceLike = { idFromName: (name) => name, get: () => stub }
    const hub = createDurableObjectHub(ns)

    const unsubscribe = hub.subscribe('game:g1', () => {})
    await new Promise((r) => setTimeout(r, 20))
    expect(subscribes).toBe(1)

    unsubscribe()
    // Wait well past the reconnect backoff: an intentional unsubscribe must NOT
    // trigger a re-subscribe (that would be a reconnect storm on purposeful close).
    await new Promise((r) => setTimeout(r, SSE_RESUBSCRIBE_DELAY_MS + 150))
    expect(subscribes).toBe(1)
  })
})

describe('R3-4 — forwardLiveSubscribe defense-in-depth (server-only, opaque channelId)', () => {
  it('narrows headers, forwards the abort signal, and treats channelId as opaque', async () => {
    let captured: Request | undefined
    let idSeed: string | undefined
    const ns: DurableObjectNamespaceLike = {
      idFromName: (name) => {
        idSeed = name
        return name
      },
      get: (): DurableObjectStubLike => ({
        fetch: async (req: Request) => {
          captured = req
          return new Response(new ReadableStream(), {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          })
        },
      }),
    }

    const ac = new AbortController()
    const clientReq = new Request('https://api.example.com/games/g1/events', {
      headers: {
        cookie: 'session=SECRET',
        authorization: 'Bearer SECRET',
        upgrade: 'websocket',
        connection: 'upgrade',
        'sec-websocket-key': 'abc123',
        accept: 'text/event-stream',
      },
      signal: ac.signal,
    })

    // channelId is opaque: an unusual value must be used VERBATIM for idFromName —
    // authz (that the channelId is legitimate for this caller) is the router's job,
    // documented on forwardLiveSubscribe. This locks that contract in.
    const opaqueChannel = 'game:tenant-a/../tenant-b:g1'
    const res = await forwardLiveSubscribe(ns, opaqueChannel, clientReq)
    expect(res.status).toBe(200)
    expect(idSeed).toBe(opaqueChannel)
    expect(captured).toBeDefined()

    // Client credentials are NOT forwarded over the internal hop.
    expect(captured!.headers.get('cookie')).toBeNull()
    expect(captured!.headers.get('authorization')).toBeNull()
    // Transport-selection headers ARE preserved (so a WS upgrade still reaches the DO).
    expect(captured!.headers.get('upgrade')).toBe('websocket')
    expect(captured!.headers.get('connection')).toBe('upgrade')
    expect(captured!.headers.get('sec-websocket-key')).toBe('abc123')
    expect(captured!.headers.get('accept')).toBe('text/event-stream')
    // The internal request targets the DO's `/subscribe` contract path.
    expect(new URL(captured!.url).pathname).toBe(REALTIME_DO_PATHS.subscribe)

    // The client abort signal is forwarded: a client disconnect aborts the DO fetch.
    expect(captured!.signal.aborted).toBe(false)
    ac.abort()
    expect(captured!.signal.aborted).toBe(true)

    void res.body?.cancel()
  })
})

/** Poll `pred` until true or a short timeout (for the async bridge pump). */
async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}
