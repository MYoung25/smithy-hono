/**
 * `createMemoryHub` — an in-process fan-out {@link RealtimeHub}.
 *
 * `notify(channelId, event)` synchronously delivers to every current subscriber
 * of that channel; `subscribe` registers a listener and returns an unsubscribe
 * fn. It holds no durable state (just the live subscriber sets) and cannot span
 * isolates — so it is the **single-node dev** hub and the **test fake** that the
 * conformance suite (and, in L4, the Cloudflare Durable Object hub) is measured
 * against. Multi-isolate deployments use {@link createPollingHub} (or the DO hub).
 *
 * Delivery is best-effort: a throwing subscriber never aborts the fan-out and
 * never makes `notify` reject (post-commit, non-throwing per the port contract).
 */

import type { RealtimeEvent, RealtimeHub } from './hub.js'

export function createMemoryHub<
  E extends RealtimeEvent = RealtimeEvent,
>(): RealtimeHub<E> {
  const channels = new Map<string, Set<(event: E) => void>>()

  return {
    async notify(channelId, event) {
      const subs = channels.get(channelId)
      if (!subs || subs.size === 0) return
      // Snapshot so a subscriber that unsubscribes (or subscribes) during
      // delivery doesn't perturb this fan-out.
      for (const onEvent of [...subs]) {
        try {
          onEvent(event)
        } catch {
          /* best-effort: one bad subscriber must not stop the others */
        }
      }
    },

    subscribe(channelId, onEvent) {
      let subs = channels.get(channelId)
      if (!subs) {
        subs = new Set()
        channels.set(channelId, subs)
      }
      subs.add(onEvent)

      let active = true
      return () => {
        if (!active) return
        active = false
        const set = channels.get(channelId)
        if (!set) return
        set.delete(onEvent)
        if (set.size === 0) channels.delete(channelId)
      }
    },
  }
}
