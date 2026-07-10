/**
 * Narrow structural ports (the PORT pattern, ARCH-01).
 *
 * These are the ONLY atomic operations the adapter's stores need from the
 * Cloudflare platform. They are declared as minimal structural interfaces so
 * that:
 *
 *   1. The production code never imports `@cloudflare/workers-types` or any SDK —
 *      a consumer's real KV binding / Durable Object storage handle structurally
 *      satisfies these shapes, so the adapter typechecks with root tooling only.
 *   2. The same store logic can be exercised against an in-process fake
 *      (see `test-support.ts`) that honors the identical atomicity contract.
 *
 * Cloudflare's real `KVNamespace`, `DurableObjectStorage`, and `DurableObjectStub`
 * are structural supersets of the `*Like` shapes below.
 */

// ---------------------------------------------------------------------------
// Workers KV — backs SessionStore (eventual consistency acceptable per plan).
// ---------------------------------------------------------------------------

/**
 * The slice of a Workers `KVNamespace` the {@link import('./sessionStore.js').KvSessionStore}
 * needs. `put` supports an `expirationTtl` (seconds) for native idle-TTL eviction.
 *
 * NOTE (consistency): Workers KV is eventually consistent — a `put` may not be
 * visible to a `get` on another edge PoP for up to ~60s. This is ACCEPTED for
 * `SessionStore` only (plan/security/11 Part B: "KV remains fine for SessionStore").
 * Rate-limit and nonce MUST NOT use KV; they use Durable Objects.
 */
export interface KvNamespaceLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Durable Objects — back RateLimitStore + NonceStore (strong, serial).
// ---------------------------------------------------------------------------

/**
 * The slice of a `DurableObjectStorage` the DO class needs: a transactional,
 * strongly-consistent per-object key/value map. Cloudflare runs each Durable
 * Object SINGLE-THREADED and SERIAL, so a read-modify-write across these awaits
 * is atomic with respect to other requests to the same object — exactly the
 * guarantee the in-process Map fake provides.
 */
export interface DurableStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>
  put<T = unknown>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  /**
   * Prefix-scoped scan of the per-object key space. Mirrors
   * `DurableObjectStorage.list({ prefix })`, which returns a `Map` of every
   * matching key to its stored value. Used by the alarm sweep to find expired
   * `rl:`/`nonce:` records to reclaim.
   */
  list(opts?: { prefix?: string }): Promise<Map<string, unknown>>
  /**
   * Arm the object's single alarm for `scheduledTimeMs` (epoch millis). Mirrors
   * `DurableObjectStorage.setAlarm`; setting it again overwrites the prior time.
   */
  setAlarm(scheduledTimeMs: number): Promise<void>
  /** The currently-armed alarm time (epoch millis), or `null` if none is set. */
  getAlarm(): Promise<number | null>
}

// ---------------------------------------------------------------------------
// DO stub ports — how a store reaches its Durable Object from a Worker isolate.
// ---------------------------------------------------------------------------

import type { RateDecision, TokenBucketSpec } from '@smithy-hono/security-core/storage'

/**
 * Structural stub for the rate-limit Durable Object. A store calls this to run
 * one atomic token-bucket `consume` inside the DO.
 *
 * The real stub (see `realPorts.ts`) serializes the call over `fetch()` to the
 * DO; the conformance fake runs the DO logic directly over an in-process Map.
 */
export interface RateLimitDoStub {
  consume(key: string, cost: number, spec: TokenBucketSpec): Promise<RateDecision>
}

/**
 * Structural stub for the nonce Durable Object. A store calls this to run one
 * atomic `checkAndStore` inside the DO.
 */
export interface NonceDoStub {
  checkAndStore(nonce: string, ttlSeconds: number): Promise<boolean>
}

// ---------------------------------------------------------------------------
// WebSocket hibernation — the OPTIONAL WS fan-out path of the realtime hub DO.
// ---------------------------------------------------------------------------

/**
 * The slice of a `DurableObjectState` the {@link import('./realtimeDurableObject.js').RealtimeDurableObject}
 * needs for the (optional, secondary) hibernating-WebSocket subscriber path —
 * exactly the parks `GameRoom` shape. `acceptWebSocket` hands a server socket to
 * the runtime so the isolate may be evicted while the socket sleeps and
 * rehydrated on the next message/notify; `getWebSockets` returns the currently
 * accepted sockets to fan a notify out to. The hub DO holds NO `storage` and NO
 * alarm (unlike {@link DurableStorageLike}) — it is a stateless relay, so this is
 * the only platform capability the WS path requires. Cloudflare's real
 * `DurableObjectState` is a structural superset.
 *
 * The SSE (MVP) path needs none of this — it tracks its own in-isolate
 * `ReadableStream` controller set — so this port is only consulted when a
 * subscriber arrives over a WebSocket upgrade.
 */
export interface HibernationStateLike {
  acceptWebSocket(ws: WebSocket): void
  getWebSockets(): WebSocket[]
}
