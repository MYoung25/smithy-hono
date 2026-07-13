/**
 * L4 → L0 integration proof: the Cloudflare Durable Object hub is a REAL
 * fan-out hub, so it MUST pass the SAME shared conformance suite the in-memory
 * hub passes (Phase L0's {@link runRealtimeHubConformance}). This is the
 * behavioral half of reconciling adapter-cf onto the `@smithy-hono/realtime`
 * port — the type-level half is the `import type { RealtimeHub, RealtimeEvent }`
 * now consumed directly in `realtimeDurableObject.ts`.
 *
 * `createDurableObjectHub` does NOT fan out in-isolate: `notify` POSTs to the
 * channel DO and `subscribe` bridges the DO's SSE stream back into `onEvent`.
 * The conformance suite asserts delivery via `notify` AND teardown via the
 * unsubscribe fn, so to run it honestly (no false-green) the fake namespace
 * must model BOTH real platform behaviors:
 *
 *   1. one DO instance per `idFromName(channelId)` (channel isolation + a
 *      shared subscriber set for notify→fan-out), and
 *   2. real `fetch`/`AbortSignal` teardown: aborting the subscribe request must
 *      cancel the DO's SSE source stream so the DO drops the subscriber. We get
 *      that by piping the DO's response body through a `{ signal }`-aware pipe —
 *      aborting the pipe cancels the source, firing the DO stream's `cancel()`
 *      (which removes the controller from the DO's live set), exactly as a real
 *      Worker→DO fetch does. Without this, `unsubscribe` would be a no-op and
 *      the suite's unsubscribe assertions would false-green.
 *
 * If a future change makes the SSE-bridge subscribe unable to model the suite
 * faithfully, prefer the direct in-isolate assertions in
 * `realtimeDurableObject.test.ts` over forcing this suite green.
 */

import { runRealtimeHubConformance } from '@smithy-hono/realtime/conformance'
import { RealtimeDurableObject, createDurableObjectHub } from './realtimeDurableObject.js'
import type { DurableObjectNamespaceLike } from './securityStores.js'
import type { DurableObjectStubLike } from './realPorts.js'

/**
 * A fake `DurableObjectNamespaceLike` over real {@link RealtimeDurableObject}
 * instances (one per channelId), with faithful abort-teardown wiring so
 * `unsubscribe` really detaches the subscriber from the DO's fan-out set.
 */
function faithfulNamespace(): DurableObjectNamespaceLike {
  const rooms = new Map<string, RealtimeDurableObject>()
  const roomFor = (channelId: string): RealtimeDurableObject => {
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
      return {
        async fetch(request: Request): Promise<Response> {
          const res = await room.fetch(request)
          // Model real fetch cancellation: when the caller aborts the subscribe
          // request, cancel the DO's SSE source so the DO drops the subscriber.
          // (`notify` POSTs carry no signal / no body to bridge — pass through.)
          if (request.signal && res.body) {
            const bridged = res.body.pipeThrough(new TransformStream(), {
              signal: request.signal,
            })
            return new Response(bridged, {
              status: res.status,
              headers: res.headers,
            })
          }
          return res
        },
      }
    },
  }
}

runRealtimeHubConformance(
  () => createDurableObjectHub(faithfulNamespace()),
  'createDurableObjectHub (Cloudflare Durable Object fan-out)',
)
