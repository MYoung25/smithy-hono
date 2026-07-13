import { describe, it, expect } from 'vitest'
import { createPollingHub, POLL_EVENT_TYPE } from './pollingHub.js'
import { LIVE_DELETED_TYPE } from './hub.js'
import type { RealtimeEvent, VersionSource } from './hub.js'

/** A VersionSource whose per-channel version is set by the test. */
function fakeSource(initial: Record<string, number | null> = {}): VersionSource & {
  set: (channelId: string, v: number | null) => void
  reads: number
} {
  const versions = new Map<string, number | null>(Object.entries(initial))
  const api = {
    reads: 0,
    async currentVersion(channelId: string): Promise<number | null> {
      api.reads++
      return versions.has(channelId) ? versions.get(channelId)! : null
    },
    set(channelId: string, v: number | null): void {
      versions.set(channelId, v)
    },
  }
  return api
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms))

describe('createPollingHub', () => {
  it('notify is a no-op (the poll is the delivery)', async () => {
    const hub = createPollingHub(fakeSource(), { intervalMs: 5 })
    await expect(
      hub.notify('game:1', { type: 'x', data: null }),
    ).resolves.toBeUndefined()
  })

  // The non-delivering signal that fails pushRecords closed in withLiveNotify.
  it('reports deliversNotify === false (non-delivering backend)', () => {
    const hub = createPollingHub(fakeSource(), { intervalMs: 5 })
    expect(hub.deliversNotify).toBe(false)
  })

  it('delivers a version hint when the version advances', async () => {
    const source = fakeSource({ 'game:1': 1 })
    const hub = createPollingHub(source, { intervalMs: 5 })
    const received: RealtimeEvent[] = []
    const off = hub.subscribe('game:1', (e) => received.push(e))

    // Let the baseline (v1) be established, then advance.
    await sleep(20)
    source.set('game:1', 2)
    await sleep(30)
    off()

    expect(received.length).toBeGreaterThanOrEqual(1)
    expect(received[0]).toEqual({
      type: POLL_EVENT_TYPE,
      data: { id: 'game:1', version: 2 },
    })
  })

  it('delivers nothing while the version does not advance', async () => {
    const source = fakeSource({ 'game:1': 7 })
    const hub = createPollingHub(source, { intervalMs: 5 })
    const received: RealtimeEvent[] = []
    const off = hub.subscribe('game:1', (e) => received.push(e))

    await sleep(40) // several poll cycles, version unchanged
    off()

    expect(received).toHaveLength(0)
  })

  it('stops polling after unsubscribe', async () => {
    const source = fakeSource({ 'game:1': 1 })
    const hub = createPollingHub(source, { intervalMs: 5 })
    const off = hub.subscribe('game:1', () => {})
    await sleep(20)
    off()
    const readsAfterUnsub = source.reads
    await sleep(30)
    // No further reads once unsubscribed (allow at most one in-flight cycle).
    expect(source.reads - readsAfterUnsub).toBeLessThanOrEqual(1)
  })

  // R1-1: a non-null → null version transition is a terminal delete signal.
  it('emits a terminal delete signal and stops when the record is deleted', async () => {
    const source = fakeSource({ 'game:1': 5 })
    const hub = createPollingHub(source, { intervalMs: 5 })
    const received: RealtimeEvent[] = []
    const off = hub.subscribe('game:1', (e) => received.push(e))

    await sleep(15) // baseline v5
    source.set('game:1', null) // deleted
    await sleep(25)

    // A single terminal delete event was delivered.
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({
      type: LIVE_DELETED_TYPE,
      data: { id: 'game:1', version: null },
    })

    // The subscription STOPPED — no further reads even without unsubscribe, and
    // a later re-create is NOT observed (client must open a fresh stream).
    const readsAfterDelete = source.reads
    source.set('game:1', 6)
    await sleep(25)
    expect(source.reads).toBe(readsAfterDelete) // loop has ended
    expect(received).toHaveLength(1)
    off()
  })

  // R1-1 corner: a channel that is null from the start (never created) must NOT
  // emit a spurious delete — it keeps polling for the record's first appearance.
  it('does not emit delete for a record that never existed', async () => {
    const source = fakeSource({}) // 'game:1' absent → currentVersion null
    const hub = createPollingHub(source, { intervalMs: 5 })
    const received: RealtimeEvent[] = []
    const off = hub.subscribe('game:1', (e) => received.push(e))

    await sleep(25)
    expect(received).toHaveLength(0)

    // It is still polling and observes the first-ever version as an advance.
    source.set('game:1', 1)
    await sleep(20)
    off()
    expect(received).toHaveLength(1)
    expect(received[0]!.type).toBe(POLL_EVENT_TYPE)
    expect((received[0]!.data as { version: number }).version).toBe(1)
  })

  // R1-2: unsubscribe during an in-flight currentVersion read must not deliver.
  it('does not deliver an event after unsubscribe races an in-flight read', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((r) => {
      release = r
    })
    let call = 0
    const source: VersionSource = {
      async currentVersion(): Promise<number | null> {
        call++
        if (call === 1) return 1 // baseline read resolves immediately
        // Second read (inside the loop) blocks until the test releases it,
        // giving the test a window to unsubscribe mid-read.
        await gate
        return 2 // an advanced version — would deliver if not for the guard
      },
    }
    const hub = createPollingHub(source, { intervalMs: 1 })
    const received: RealtimeEvent[] = []
    const off = hub.subscribe('game:1', (e) => received.push(e))

    await sleep(15) // baseline established; loop is now parked on the 2nd read
    off() // unsubscribe while currentVersion is in flight
    release!() // let the in-flight read resolve with an advanced version
    await sleep(15)

    expect(received).toHaveLength(0) // stopped guard suppressed post-detach delivery
  })
})
