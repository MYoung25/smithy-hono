/**
 * `createPollingHub` — the isolate-safe {@link RealtimeHub} backend.
 *
 * Generalizes the hand-written deep-dive / point-city `sse.ts` loop: because an
 * in-memory bus cannot span Cloudflare Workers isolates, each subscriber runs a
 * self-contained loop that reads the channel's store-managed `version` (via the
 * narrow {@link VersionSource} port) every `intervalMs` and, when it advances,
 * emits a version hint. The client version-guards and refetches — a dropped read
 * is non-lossy because the next poll re-observes the same (or newer) version.
 *
 * `notify` is a **no-op**: for this backend the poll IS the delivery, so the
 * write path calling `hub.notify(...)` (via `withLiveNotify`) is a harmless
 * no-op and the same generated code works against either backend unchanged.
 *
 * Runs anywhere — no Durable Object, no platform capability — so it is the
 * correctness baseline (the DO push hub in L4 is a pure latency/scale
 * optimization behind the same port).
 */

import type {
  PollingHubOptions,
  RealtimeEvent,
  RealtimeHub,
  VersionSource,
} from './hub.js'
import { LIVE_DELETED_TYPE } from './hub.js'

export type { PollingHubOptions } from './hub.js'

const DEFAULT_INTERVAL_MS = 1500

/**
 * The `type` a polling subscriber emits on a version-advance. The polling hub
 * only knows "this channel's version changed", not the resource's concrete
 * event name, so it emits this neutral hint type; {@link liveEventStream}
 * (which is given the resource's `eventTypes`) relabels it to the primary type.
 */
export const POLL_EVENT_TYPE = 'live:updated'

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export function createPollingHub(
  source: VersionSource,
  opts: PollingHubOptions = {},
): RealtimeHub {
  const intervalMs =
    opts.intervalMs && opts.intervalMs > 0 ? opts.intervalMs : DEFAULT_INTERVAL_MS

  return {
    // This backend does NOT deliver a `notify` body: the poll loop re-reads only
    // the channel `version` and emits `{ id, version }` hints. `withLiveNotify`
    // reads this flag to fail closed when paired with `pushRecords: true` (a
    // record frame handed to the no-op `notify` below would be silently dropped).
    deliversNotify: false,

    // The poll is the delivery — nothing to fan out from the write path.
    async notify() {
      /* no-op */
    },

    subscribe(channelId, onEvent) {
      let stopped = false

      void (async () => {
        // Establish a baseline WITHOUT emitting, so a subscriber that connects
        // to an already-existing record isn't spammed with a spurious "update"
        // for a version it hasn't advanced past. (The client did its initial
        // fetch before subscribing; subscription delivers only what's NEW.)
        let lastVersion: number | null
        try {
          lastVersion = await source.currentVersion(channelId)
        } catch {
          lastVersion = null
        }

        while (!stopped) {
          await sleep(intervalMs)
          if (stopped) break

          let version: number | null
          try {
            version = await source.currentVersion(channelId)
          } catch {
            // Transient read failure — self-heals on the next poll.
            continue
          }

          // R1-2: unsubscribe may have fired during the in-flight read above.
          // Re-check before any delivery so no event is emitted post-detach
          // (mirrors memoryHub's strict `active` guard).
          if (stopped) break

          if (version !== null && version !== lastVersion) {
            lastVersion = version
            const event: RealtimeEvent = {
              type: POLL_EVENT_TYPE,
              data: { id: channelId, version },
            }
            try {
              onEvent(event)
            } catch {
              /* best-effort delivery */
            }
          } else if (version === null && lastVersion !== null) {
            // R1-1: the version transitioned non-null → null — the record was
            // deleted. Mirror the hand-written `sse.ts` `if (!record) break`:
            // emit a terminal delete signal, then STOP the subscription so the
            // client's stream ends (liveEventStream closes on this type). A
            // client that wants to watch for a re-create opens a fresh stream.
            lastVersion = null
            const event: RealtimeEvent = {
              type: LIVE_DELETED_TYPE,
              data: { id: channelId, version: null },
            }
            try {
              onEvent(event)
            } catch {
              /* best-effort delivery */
            }
            break
          }
          // (version === null && lastVersion === null): record never existed
          // yet — keep the null baseline and keep polling for its first appearance.
        }
      })()

      return () => {
        stopped = true
      }
    },
  }
}
