/**
 * `liveEventStream` — the hono `streamSSE` bridge for a {@link RealtimeHub}.
 *
 * Generalizes the `return streamSSE(c, ...)` block the deep-dive / point-city
 * `sse.ts` files hand-write: it subscribes to `hub` for `channelId`, writes each
 * delivered event as an SSE frame (`event: <type>`, `data: JSON.stringify(...)`,
 * matching the existing typed `…EventSource` client), and unsubscribes when the
 * client aborts. Backend-agnostic — the same call works whether `hub` is the
 * polling hub, the memory hub, or (L4) the Durable Object hub.
 *
 * `eventTypes` is the resource's live event types, **primary/update type first**.
 * A delivered event whose `type` is one of `eventTypes` is written under that
 * type (the push path: `withLiveNotify` emits the concrete `eventType`). A
 * delivered event whose `type` is NOT in `eventTypes` — i.e. the polling hub's
 * neutral version hint — is written under `eventTypes[0]`, so a poll-backed
 * deployment reaches a client listening for the resource's named update event.
 * When `eventTypes` is empty, events are written under their own `type`.
 *
 * The reserved terminal {@link LIVE_DELETED_TYPE} is the exception: it is written
 * verbatim (never relabeled) and then **closes the stream** (R1-1). Per-connection
 * pending events are held in a bounded, coalescing queue (R1-3).
 */

import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { RealtimeEvent, RealtimeHub } from './hub.js'
import { LIVE_DELETED_TYPE } from './hub.js'

export interface LiveEventStreamOptions {
  /**
   * SSE heartbeat comment interval in ms — keeps proxies from idling the
   * connection out during quiet periods. Default 20000. Set `0` to disable.
   */
  heartbeatMs?: number
  /**
   * Hard cap on the per-connection pending-event queue (R1-3). See
   * {@link createBoundedEventQueue} for the drop policy. Default 256.
   */
  maxQueueLength?: number
}

const DEFAULT_HEARTBEAT_MS = 20_000
const DEFAULT_MAX_QUEUE_LENGTH = 256

/**
 * A bounded, **coalescing** pending-event queue for one SSE connection (R1-3).
 *
 * Without a bound the queue grows unbounded when a producer (subscribe
 * callbacks) outpaces a slow consumer (`writeSSE` blocked on TCP backpressure).
 * Policy: on `push`, an already-queued event **of the same `type`** is dropped
 * in favour of the newer one (coalesce-to-latest) — safe because clients
 * reconcile via a monotonic `version`, so only the newest hint of a type
 * matters. This alone bounds the queue to the number of distinct event types
 * (a small constant: an update type + the terminal delete). A hard `maxLength`
 * backstop drops the oldest if distinct types somehow exceed the cap. The
 * terminal {@link LIVE_DELETED_TYPE} is never coalesced away by a later event
 * because it is the last event a channel ever produces.
 */
export interface BoundedEventQueue {
  push(event: RealtimeEvent): void
  shift(): RealtimeEvent | undefined
  readonly length: number
}

export function createBoundedEventQueue(
  maxLength: number = DEFAULT_MAX_QUEUE_LENGTH,
): BoundedEventQueue {
  const cap = maxLength > 0 ? maxLength : DEFAULT_MAX_QUEUE_LENGTH
  const items: RealtimeEvent[] = []
  return {
    push(event: RealtimeEvent): void {
      const existing = items.findIndex((e) => e.type === event.type)
      if (existing !== -1) items.splice(existing, 1)
      items.push(event)
      while (items.length > cap) items.shift()
    },
    shift(): RealtimeEvent | undefined {
      return items.shift()
    },
    get length(): number {
      return items.length
    },
  }
}

export function liveEventStream(
  c: Context,
  hub: RealtimeHub,
  channelId: string,
  eventTypes: readonly string[],
  opts: LiveEventStreamOptions = {},
): Response | Promise<Response> {
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS

  return streamSSE(c, async (stream) => {
    const queue = createBoundedEventQueue(opts.maxQueueLength)
    let done = false
    // Resolver for the current idle wait; invoking it wakes the writer loop.
    let wake: (() => void) | null = null
    const wakeUp = (): void => {
      const w = wake
      wake = null
      w?.()
    }

    const unsubscribe = hub.subscribe(channelId, (event) => {
      queue.push(event)
      wakeUp()
    })

    stream.onAbort(() => {
      done = true
      wakeUp()
    })

    // Resolve on the next event, on abort, or after `heartbeatMs` (whichever is
    // first). The timer is cleared on early wake so it never leaks.
    const waitNext = (): Promise<void> =>
      new Promise((resolve) => {
        if (queue.length > 0 || done) {
          resolve()
          return
        }
        let settled = false
        const finish = (): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          wake = null
          resolve()
        }
        const timer =
          heartbeatMs > 0 ? setTimeout(finish, heartbeatMs) : undefined
        wake = finish
      })

    let id = 0
    try {
      while (!done && !stream.closed) {
        await waitNext()
        if (done || stream.closed) break

        if (queue.length === 0) {
          // Idle timeout elapsed with nothing queued → heartbeat comment.
          await stream.write(': heartbeat\n\n')
          continue
        }

        while (queue.length > 0 && !done && !stream.closed) {
          const event = queue.shift()!
          // R1-1: a terminal delete is written under its reserved type (never
          // relabeled to a resource update type) and then closes the stream, so
          // a client watching a deleted record isn't left on an open connection.
          const isDeleted = event.type === LIVE_DELETED_TYPE
          const type = isDeleted
            ? LIVE_DELETED_TYPE
            : eventTypes.length === 0 || eventTypes.includes(event.type)
              ? event.type
              : eventTypes[0]
          await stream.writeSSE({
            event: type,
            data: JSON.stringify(event.data),
            id: String(++id),
          })
          if (isDeleted) {
            done = true
            break
          }
        }
      }
    } catch {
      // Writes throw once the client is gone — end the stream cleanly.
    } finally {
      unsubscribe()
    }
  })
}
