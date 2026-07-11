/**
 * `@smithy-hono/realtime` — the opt-in realtime notify-hub runtime.
 *
 * Barrel for the backend-agnostic core: the {@link RealtimeHub} port + event
 * types, the {@link VersionSource} structural port, the poll-anywhere
 * {@link createPollingHub} and in-process {@link createMemoryHub} backends, the
 * {@link withLiveNotify} notify-on-commit store decorator, and the
 * {@link liveEventStream} hono SSE bridge.
 *
 * The conformance suite is intentionally NOT re-exported here (it imports
 * `vitest`); consumers pull it from the `@smithy-hono/realtime/conformance`
 * subpath, mirroring `@smithy-hono/data-core/conformance`.
 */

export type {
  RealtimeEvent,
  RealtimeHub,
  VersionSource,
  PollingHubOptions,
} from './hub.js'
export { LIVE_DELETED_TYPE } from './hub.js'

export { createMemoryHub } from './memoryHub.js'
export { createPollingHub, POLL_EVENT_TYPE } from './pollingHub.js'
export { withLiveNotify, type LiveNotifyOptions } from './withLiveNotify.js'
export { liveEventStream, type LiveEventStreamOptions } from './endpoint.js'
