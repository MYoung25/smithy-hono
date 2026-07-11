import { describe, it, expect } from 'vitest'
import { createMemoryDataStore } from '@smithy-hono/data-core/memory'
import type { RealtimeEvent, RealtimeHub, VersionSource } from './hub.js'
import { LIVE_DELETED_TYPE } from './hub.js'
import { createMemoryHub } from './memoryHub.js'
import { createPollingHub } from './pollingHub.js'
import { withLiveNotify } from './withLiveNotify.js'

interface Game extends Record<string, unknown> {
  id: string
  name: string
}

const NO_SCOPE = {}

/** A hub that records every notify call (channelId + event). */
function recordingHub(): RealtimeHub & { calls: Array<{ channelId: string; event: RealtimeEvent }> } {
  const calls: Array<{ channelId: string; event: RealtimeEvent }> = []
  return {
    calls,
    async notify(channelId, event) {
      calls.push({ channelId, event })
    },
    subscribe() {
      return () => {}
    },
  }
}

describe('withLiveNotify', () => {
  it('notifies with the pinned channel key and a { id, version } hint after create', async () => {
    const hub = recordingHub()
    const store = withLiveNotify(createMemoryDataStore<Game>(), hub, {
      resource: 'Game', // lowercased into the channel key
      eventType: 'game:updated',
    })

    const saved = await store.create('g1', { id: 'g1', name: 'Ada' }, NO_SCOPE)

    expect(hub.calls).toHaveLength(1)
    expect(hub.calls[0]!.channelId).toBe('game:g1')
    expect(hub.calls[0]!.event).toEqual({
      type: 'game:updated',
      data: { id: 'g1', version: saved.version },
    })
  })

  it('notifies after put / update / patch with the advancing version', async () => {
    const hub = recordingHub()
    const store = withLiveNotify(createMemoryDataStore<Game>(), hub, {
      resource: 'game',
      eventType: 'game:updated',
    })

    await store.put('g1', { id: 'g1', name: 'v1' }, NO_SCOPE) // v1
    await store.update('g1', { id: 'g1', name: 'v2' }, undefined, NO_SCOPE) // v2
    await store.patch('g1', { name: 'v3' }, undefined, NO_SCOPE) // v3

    expect(hub.calls.map((c) => (c.event.data as { version: number }).version)).toEqual([
      1, 2, 3,
    ])
    expect(hub.calls.every((c) => c.channelId === 'game:g1')).toBe(true)
  })

  it('notifies after delete with the terminal type, only when something was deleted', async () => {
    const hub = recordingHub()
    const store = withLiveNotify(createMemoryDataStore<Game>(), hub, {
      resource: 'game',
      eventType: 'game:updated',
    })
    await store.create('g1', { id: 'g1', name: 'Ada' }, NO_SCOPE)
    hub.calls.length = 0

    expect(await store.delete('g1', undefined, NO_SCOPE)).toBe(true)
    expect(hub.calls).toHaveLength(1)
    // R1-1: delete emits the reserved terminal type, not the update eventType.
    expect(hub.calls[0]!.event).toEqual({
      type: LIVE_DELETED_TYPE,
      data: { id: 'g1', version: null },
    })

    // A no-op delete (nothing there) must NOT notify.
    hub.calls.length = 0
    expect(await store.delete('g1', undefined, NO_SCOPE)).toBe(false)
    expect(hub.calls).toHaveLength(0)
  })

  it('does NOT notify before the write commits (a failed create never fires)', async () => {
    const hub = recordingHub()
    const store = withLiveNotify(createMemoryDataStore<Game>(), hub, {
      resource: 'game',
      eventType: 'game:updated',
    })
    await store.create('g1', { id: 'g1', name: 'first' }, NO_SCOPE)
    hub.calls.length = 0

    // create over an existing key rejects → no commit → no notify.
    await expect(
      store.create('g1', { id: 'g1', name: 'dup' }, NO_SCOPE),
    ).rejects.toThrow()
    expect(hub.calls).toHaveLength(0)
  })

  it('pushRecords mode ships a { records, version } frame', async () => {
    const hub = recordingHub()
    const store = withLiveNotify(createMemoryDataStore<Game>(), hub, {
      resource: 'game',
      eventType: 'game:updated',
      pushRecords: true,
    })

    const saved = await store.create('g1', { id: 'g1', name: 'Ada' }, NO_SCOPE)
    expect(hub.calls[0]!.event.data).toEqual({
      records: [saved],
      version: saved.version,
    })

    hub.calls.length = 0
    await store.delete('g1', undefined, NO_SCOPE)
    expect(hub.calls[0]!.event.data).toEqual({ records: [], version: null })
  })

  it('a throwing hub does not fail the write; the write still commits', async () => {
    const throwingHub: RealtimeHub = {
      async notify() {
        throw new Error('hub is down')
      },
      subscribe() {
        return () => {}
      },
    }
    const store = withLiveNotify(createMemoryDataStore<Game>(), throwingHub, {
      resource: 'game',
      eventType: 'game:updated',
    })

    const saved = await store.create('g1', { id: 'g1', name: 'Ada' }, NO_SCOPE)
    expect(saved.version).toBe(1)
    // The write is durable regardless of the notify failure.
    expect(await store.get('g1', NO_SCOPE)).not.toBeNull()
  })

  it('reads and list pass through unchanged and never notify', async () => {
    const hub = recordingHub()
    const store = withLiveNotify(createMemoryDataStore<Game>(), hub, {
      resource: 'game',
      eventType: 'game:updated',
    })
    await store.create('g1', { id: 'g1', name: 'Ada' }, NO_SCOPE)
    hub.calls.length = 0

    expect((await store.get('g1', NO_SCOPE))!.name).toBe('Ada')
    expect((await store.list({ limit: 10 }, NO_SCOPE)).items).toHaveLength(1)
    expect(hub.calls).toHaveLength(0)
  })

  // R1-4: the decorator forwards the store's FULL surface — including methods
  // beyond the DataStore interface and prototype (class) methods — untouched.
  it('forwards store methods beyond the notified mutating set (incl. prototype/extra methods)', async () => {
    const hub = recordingHub()

    // `count` lives on the underlying store; it is not a notified mutator, so it
    // must pass through. (The real memory store is a class — its methods live on
    // the prototype, which a shallow spread would have dropped.)
    const base = createMemoryDataStore<Game>()
    // A method beyond the DataStore interface entirely — must still be forwarded.
    const extended = Object.assign(base, {
      customStat(): string {
        return 'ok'
      },
    })
    const store = withLiveNotify(extended, hub, {
      resource: 'game',
      eventType: 'game:updated',
    }) as typeof extended

    await store.create('g1', { id: 'g1', name: 'Ada' }, NO_SCOPE)
    await store.create('g2', { id: 'g2', name: 'Bob' }, NO_SCOPE)
    hub.calls.length = 0

    // Prototype method beyond the notified set: forwarded, does not notify.
    expect(await store.count!({}, NO_SCOPE)).toBe(2)
    // Method beyond the DataStore interface: forwarded, does not notify.
    expect(store.customStat()).toBe('ok')
    expect(hub.calls).toHaveLength(0)
  })

  // Fail-closed guard: pushRecords requires a delivering (push) backend.
  describe('pushRecords fail-closed guard (deliversNotify)', () => {
    const emptySource: VersionSource = {
      async currentVersion() {
        return null
      },
    }

    it('THROWS at construction when pushRecords:true is paired with a polling hub', () => {
      const pollingHub = createPollingHub(emptySource)
      expect(pollingHub.deliversNotify).toBe(false)
      expect(() =>
        withLiveNotify(createMemoryDataStore<Game>(), pollingHub, {
          resource: 'game',
          eventType: 'game:updated',
          pushRecords: true,
        }),
      ).toThrow(/pushRecords requires a push backend/)
    })

    it('ALLOWS pushRecords:true with a delivering memory hub (frame is delivered)', async () => {
      const memHub = createMemoryHub()
      const store = withLiveNotify(createMemoryDataStore<Game>(), memHub, {
        resource: 'game',
        eventType: 'game:updated',
        pushRecords: true,
      })
      const received: RealtimeEvent[] = []
      memHub.subscribe('game:g1', (e) => received.push(e))

      const saved = await store.create('g1', { id: 'g1', name: 'Ada' }, NO_SCOPE)
      expect(received).toHaveLength(1)
      expect(received[0]!.data).toEqual({ records: [saved], version: saved.version })
    })

    it('ALLOWS hint mode (pushRecords falsy) on a polling hub — unchanged', async () => {
      const pollingHub = createPollingHub(emptySource)
      // No throw; hint mode is valid on the non-delivering polling backend.
      const store = withLiveNotify(createMemoryDataStore<Game>(), pollingHub, {
        resource: 'game',
        eventType: 'game:updated',
      })
      // The write still commits; notify is the polling hub's harmless no-op.
      const saved = await store.create('g1', { id: 'g1', name: 'Ada' }, NO_SCOPE)
      expect(saved.version).toBe(1)
    })

    it('ALLOWS pushRecords:true when deliversNotify is absent (assumed to deliver)', () => {
      // A hub that omits deliversNotify (e.g. adapter-cf's DO hub) is treated as
      // delivering, so pushRecords is accepted with no change to that hub.
      const bareHub: RealtimeHub = {
        async notify() {},
        subscribe() {
          return () => {}
        },
      }
      expect(bareHub.deliversNotify).toBeUndefined()
      expect(() =>
        withLiveNotify(createMemoryDataStore<Game>(), bareHub, {
          resource: 'game',
          eventType: 'game:updated',
          pushRecords: true,
        }),
      ).not.toThrow()
    })
  })
})
