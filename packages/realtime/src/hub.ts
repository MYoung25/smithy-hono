/**
 * The `RealtimeHub` port (Phase L0 — realtime notify-hub).
 *
 * A single narrow pub/sub port behind the codegen'd `@live` realtime endpoint,
 * generalizing the `…EventEmitter.emit(channelId, event)` surface into a
 * subscribe+notify pair. Three real downstream services (parks, deep-dive,
 * point-city) hand-roll the same "keyed notify hub, no durable state, external
 * DataStore is the source of truth, clients reconcile on a monotonic `version`"
 * pattern; this port makes it first-class.
 *
 * Two backends implement it (chosen at deploy time, not codegen time):
 *  - {@link createPollingHub} — polls a {@link VersionSource} per subscriber and
 *    delivers on version-advance; `notify` is a no-op (the poll IS delivery).
 *    Runs anywhere (no Durable Object) — the free-plan / D1-only path.
 *  - {@link createMemoryHub} — in-process fan-out; `notify` actually delivers.
 *    The test fake + single-node dev path (and the shape the Cloudflare Durable
 *    Object hub will match in L4).
 *
 * Both are validated by {@link runRealtimeHubConformance} the same way the repo
 * validates every port (ARCH-01): structural port → in-memory fake → shared
 * conformance suite → real backend.
 *
 * Web-standard only (ARCH-01): no `node:*`. This package must run identically on
 * Node and on Cloudflare Workers isolates.
 */

/** A realtime event: a `type` discriminator plus an opaque JSON `data` payload. */
export interface RealtimeEvent {
  type: string
  data: unknown
}

/**
 * The reserved **terminal** event `type`: a record on this channel was deleted.
 *
 * Unlike a version-advance hint (which a version-guarding client can no-op if it
 * has already seen a newer version), a delete is a distinguished, non-lossy
 * signal. Both write paths emit it — {@link createPollingHub} when the channel's
 * version transitions non-null → null, and {@link withLiveNotify} on a committed
 * `delete` — and {@link liveEventStream} turns it into a final SSE frame and
 * then **closes the stream**, so a client watching a deleted record isn't left
 * hanging on an open connection.
 *
 * Client-side contract (the generated router/client, out of this package):
 *  - Listen for an SSE event named `live:deleted` on the resource's live stream.
 *  - On receipt, treat the record as gone (drop it / show a deleted state); do
 *    NOT version-guard it against the last-known version — it is terminal.
 *  - The server closes the connection right after this frame; a client that
 *    wants to keep watching (e.g. for a re-create) must open a fresh stream.
 */
export const LIVE_DELETED_TYPE = 'live:deleted'

/**
 * A keyed pub/sub coordination point. Holds **no durable state** — an external
 * `DataStore` is the source of truth; the hub only fans a post-commit
 * notification out to current subscribers of a channel.
 *
 * Channel keys are **opaque** to the hub. By convention (pinned across the
 * codegen) a channel id is `` `${resource}:${id}` `` — the lowercased resource
 * name and the record id — but the hub never parses or interprets it.
 */
export interface RealtimeHub<E extends RealtimeEvent = RealtimeEvent> {
  /**
   * Whether this backend actually **delivers** the `event` passed to
   * {@link notify} to subscribers (its full body, not just a re-derived version
   * hint). Optional and **defaults to delivering** when absent:
   *  - `undefined` (absent) → assume the backend delivers. Existing/other-package
   *    hubs (e.g. adapter-cf's `createDurableObjectHub`) need no change — a push
   *    backend fans `notify` out, so record frames arrive.
   *  - `false` → `notify` is a no-op; the backend cannot ship a `notify` body.
   *    {@link createPollingHub} sets this: its poll loop re-reads only the
   *    channel `version` and emits `{ id, version }` hints, so a record frame
   *    handed to its no-op `notify` would be silently dropped.
   *
   * {@link withLiveNotify} reads this to **fail closed** at construction time
   * when `pushRecords: true` is paired with a non-delivering backend, rather than
   * silently losing every record frame at runtime.
   */
  readonly deliversNotify?: boolean

  /**
   * Push `event` to every current subscriber of `channelId`. **Best-effort and
   * non-throwing**: a delivery failure is swallowed (clients self-heal via their
   * version-guarded poll/refetch). Called post-commit from the write path.
   *
   * `createPollingHub().notify` is a no-op — for the polling backend the poll
   * loop, not `notify`, is the delivery mechanism (and `deliversNotify` is
   * `false`).
   */
  notify(channelId: string, event: E): Promise<void>

  /**
   * Attach a subscriber to `channelId`. Returns an unsubscribe function; call it
   * to detach (e.g. on stream abort). The endpoint drives the transport.
   */
  subscribe(channelId: string, onEvent: (event: E) => void): () => void
}

/**
 * A narrow structural port over "the current monotonic version of a channel's
 * record" — the {@link createPollingHub} reads it every interval to detect a
 * committed write. Backed by the same `DataStore` the resource already uses
 * (`currentVersion(id)` = `store.get(id, scope)?.version ?? null`), so the hub
 * imports no adapter. `null` means the record is absent (never created / deleted).
 */
export interface VersionSource {
  currentVersion(channelId: string): Promise<number | null>
}

/** Options for {@link createPollingHub}. */
export interface PollingHubOptions {
  /** Poll interval in ms (how often each subscriber reads the version). Default ~1500. */
  intervalMs?: number
}
