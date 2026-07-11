/**
 * Shared, reusable {@link RealtimeHub} conformance suite (Phase L0).
 *
 * Any **fan-out** hub — the in-memory one here, and (L4) the Cloudflare Durable
 * Object hub — MUST pass this suite; that's how we keep behavioral parity across
 * backends (ARCH-01: structural port → in-memory fake → conformance → real impl).
 *
 * NB: this asserts delivery **via `notify`**, so it targets fan-out hubs only.
 * {@link createPollingHub} intentionally makes `notify` a no-op (its delivery is
 * the poll loop), so it is NOT run through this suite — it has its own
 * version-advance unit tests.
 *
 * This file imports only `vitest` — no `node:*` (ARCH-01).
 */

import { describe, it, expect } from 'vitest'
import type { RealtimeEvent, RealtimeHub } from './hub.js'

/** A hub factory: returns a fresh, isolated fan-out hub per test. */
export type HubFactory = () => RealtimeHub | Promise<RealtimeHub>

/** Wait a macrotask so any async fan-out settles before asserting. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/**
 * Register the {@link RealtimeHub} conformance suite for one fan-out backend.
 *
 * @param makeHub  fresh-hub factory (called once per test).
 * @param name     optional label for the describe block.
 */
export function runRealtimeHubConformance(
  makeHub: HubFactory,
  name = 'RealtimeHub',
): void {
  const ev = (type: string, data: unknown): RealtimeEvent => ({ type, data })

  describe(`RealtimeHub conformance: ${name}`, () => {
    it('delivers a notify to a current subscriber of the channel', async () => {
      const hub = await makeHub()
      const received: RealtimeEvent[] = []
      hub.subscribe('game:1', (e) => received.push(e))

      await hub.notify('game:1', ev('game:updated', { id: 'game:1', version: 2 }))
      await tick()

      expect(received).toHaveLength(1)
      expect(received[0]).toEqual({
        type: 'game:updated',
        data: { id: 'game:1', version: 2 },
      })
    })

    it('does NOT deliver to a subscriber of a different channel', async () => {
      const hub = await makeHub()
      const a: RealtimeEvent[] = []
      const b: RealtimeEvent[] = []
      hub.subscribe('game:1', (e) => a.push(e))
      hub.subscribe('game:2', (e) => b.push(e))

      await hub.notify('game:1', ev('game:updated', { version: 1 }))
      await tick()

      expect(a).toHaveLength(1)
      expect(b).toHaveLength(0) // channel isolation
    })

    it('fans out to every current subscriber of the channel', async () => {
      const hub = await makeHub()
      const a: RealtimeEvent[] = []
      const b: RealtimeEvent[] = []
      hub.subscribe('game:1', (e) => a.push(e))
      hub.subscribe('game:1', (e) => b.push(e))

      await hub.notify('game:1', ev('game:updated', { version: 3 }))
      await tick()

      expect(a).toHaveLength(1)
      expect(b).toHaveLength(1)
    })

    it('stops delivering after unsubscribe', async () => {
      const hub = await makeHub()
      const received: RealtimeEvent[] = []
      const unsubscribe = hub.subscribe('game:1', (e) => received.push(e))

      await hub.notify('game:1', ev('game:updated', { version: 1 }))
      await tick()
      expect(received).toHaveLength(1)

      unsubscribe()
      await hub.notify('game:1', ev('game:updated', { version: 2 }))
      await tick()
      expect(received).toHaveLength(1) // no further delivery
    })

    it('unsubscribe is idempotent and detaches only its own subscriber', async () => {
      const hub = await makeHub()
      const a: RealtimeEvent[] = []
      const b: RealtimeEvent[] = []
      const unsubA = hub.subscribe('game:1', (e) => a.push(e))
      hub.subscribe('game:1', (e) => b.push(e))

      unsubA()
      unsubA() // idempotent — must not throw or detach B

      await hub.notify('game:1', ev('game:updated', { version: 1 }))
      await tick()

      expect(a).toHaveLength(0)
      expect(b).toHaveLength(1)
    })

    it('notify with no subscribers is a no-op that does not throw', async () => {
      const hub = await makeHub()
      await expect(
        hub.notify('nobody:home', ev('game:updated', { version: 1 })),
      ).resolves.toBeUndefined()
    })

    it('a throwing subscriber does not break fan-out to the others, and notify never rejects', async () => {
      const hub = await makeHub()
      const good: RealtimeEvent[] = []
      hub.subscribe('game:1', () => {
        throw new Error('subscriber blew up')
      })
      hub.subscribe('game:1', (e) => good.push(e))

      await expect(
        hub.notify('game:1', ev('game:updated', { version: 1 })),
      ).resolves.toBeUndefined()
      await tick()

      expect(good).toHaveLength(1) // the healthy subscriber still received it
    })
  })
}
