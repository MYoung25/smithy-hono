/**
 * The four pluggable storage interfaces (ARCH-03).
 *
 * One interface per stateful security concern. Every stateful concern in the
 * security layer (sessions, rate limits, replay nonces, signing keys) MUST go
 * through one of these — never through module-level in-memory state (ARCH-02),
 * which gives no consistency guarantees on Workers isolates / Lambda containers.
 *
 * All methods are async (backends are network-bound), all keyed by `string`,
 * and the interfaces deliberately use only Web-standard types (`CryptoKey`),
 * never `node:*` (ARCH-01). Concrete backends (Durable Objects, Redis,
 * DynamoDB-CAS, Secrets Manager, ...) are Phase S10 adapter packages; the
 * dev-only in-memory implementations live in `./memory`.
 */

// ---------------------------------------------------------------------------
// Principal — the authenticated identity carried through the pipeline.
// ---------------------------------------------------------------------------

/**
 * The authenticated identity resolved by Phase S5 (cookie/OIDC) or Phase S6
 * (HMAC S2S). Defined here, minimally, because {@link SessionRecord} references
 * it. Later phases (auth / authz, docs 06 & 12) consume and may extend this
 * shape; the optional `tenantId` is the locked multi-tenancy seam (AUTHZ-07) —
 * single-tenant apps leave it unset.
 */
export interface Principal {
  /** Stable identifier for the subject (user or service). */
  id: string
  /** Permissions derived from session claims / OIDC scopes via the app's mapper. */
  permissions: string[]
  /** Optional tenant/org context — set by the claim mapper when multi-tenant (AUTHZ-07). */
  tenantId?: string
  /** Raw claims bag from the upstream IdP; opaque to core. */
  claims: Record<string, unknown>
  /** Whether this principal is a browser user or a service-to-service caller. */
  kind: 'user' | 'service'
}

// ---------------------------------------------------------------------------
// SessionStore (AUTH-04/05, CSRF-03)
// ---------------------------------------------------------------------------

/**
 * Server-side session state. The session ID (the map key) is the only thing the
 * browser ever holds (in a `__Host-` cookie, AUTH-03/06); everything else lives
 * here so revocation (AUTH-04) and timeouts (AUTH-05) stay server-authoritative.
 */
export interface SessionRecord {
  /** The authenticated principal this session represents. */
  principal: Principal
  /** Epoch millis when the session was first minted (issued). */
  createdAt: number
  /**
   * Hard cap — epoch millis after which the session is invalid regardless of
   * activity (AUTH-05 absolute timeout). The idle timeout is the store TTL,
   * slid by {@link SessionStore.touch}; this is the ceiling that TTL can't lift.
   */
  absoluteExpiry: number
  /**
   * The CSRF synchronizer token (CSRF-03). Verified "for free" by the CSRF
   * middleware (Phase S8) off the already-loaded session record — no extra read.
   */
  csrfToken: string
  /** Opaque application/IdP claims bag carried with the session. */
  claims: Record<string, unknown>
}

export interface SessionStore {
  /** Resolve a session by ID, or `null` if absent/expired-by-backend. */
  get(sessionId: string): Promise<SessionRecord | null>
  /** Create/replace a session with an initial idle TTL (seconds). */
  set(sessionId: string, rec: SessionRecord, ttlSeconds: number): Promise<void>
  /** Revoke a session immediately (AUTH-04). Idempotent. */
  delete(sessionId: string): Promise<void>
  /** Slide the idle TTL on access (AUTH-05). No-op if the session is gone. */
  touch(sessionId: string, idleTtlSeconds: number): Promise<void>
}

// ---------------------------------------------------------------------------
// RateLimitStore (RATE-01/07, SIGN — strongly consistent)
// ---------------------------------------------------------------------------

/** Token-bucket parameters for a single limiter key. */
export interface TokenBucketSpec {
  /** Maximum tokens the bucket can hold (burst ceiling). */
  capacity: number
  /** Tokens replenished per second (sustained rate). */
  refillPerSecond: number
}

/** The outcome of a single {@link RateLimitStore.consume} call. */
export interface RateDecision {
  /** Whether the request is permitted (enough tokens for `cost`). */
  allowed: boolean
  /** Tokens left in the bucket after this decision. */
  remaining: number
  /** Epoch millis at which the bucket is expected to be full again. */
  resetAt: number
  /**
   * Seconds the caller should wait before retrying — surfaced as `Retry-After`
   * on a 429 `ThrottlingException` (RATE-02). `0` when allowed.
   */
  retryAfterSeconds: number
}

/**
 * Atomic token-bucket limiter.
 *
 * **Strong consistency is required** (locked decision, docs 00 & 08): a single
 * logical bucket MUST NOT overspend across concurrent callers. Real backends
 * are Durable Objects / Redis / conditional-write DynamoDB — never eventually
 * consistent KV — so RATE-01 limits are exact. Conformance enforces a
 * no-overspend invariant on concurrent consume.
 */
export interface RateLimitStore {
  /**
   * Atomically attempt to remove `cost` tokens from `key`'s bucket.
   * Returns the decision + remaining/reset accounting.
   */
  consume(key: string, cost: number, limit: TokenBucketSpec): Promise<RateDecision>
}

// ---------------------------------------------------------------------------
// NonceStore (SIGN-03/10 — replay defense)
// ---------------------------------------------------------------------------

/**
 * Single-use token / signature tracking for replay defense (SIGN-03/10).
 *
 * **Strong consistency is required** (locked decision, docs 00 & 07): a replayed
 * nonce within the window MUST be rejected, so the store must be read-after-write
 * consistent and atomic on first-write-wins — not best-effort KV. Conformance
 * enforces exactly-one-acceptance under concurrent checks of the same nonce.
 */
export interface NonceStore {
  /**
   * Atomically record `nonce` if unseen. Returns `true` if it was newly stored
   * (accept the request) or `false` if already present within its TTL (replay,
   * reject). TTL = the signing acceptance window, in seconds.
   */
  checkAndStore(nonce: string, ttlSeconds: number): Promise<boolean>
}

// ---------------------------------------------------------------------------
// SecretProvider (SIGN-05/06)
// ---------------------------------------------------------------------------

/**
 * Resolves HMAC signing keys for S2S request verification (Phase S6). Keys live
 * only in the backing secrets store (Secrets Manager / Workers secrets / k8s) —
 * never in code or config (SIGN-06). Returns Web-standard {@link CryptoKey}s
 * imported via `crypto.subtle.importKey` (ARCH-01).
 */
export interface SecretProvider {
  /**
   * Resolve the `CryptoKey` for a given key ID, or `null` if unknown/retired.
   * During rotation the provider accepts both the current and previous key ID
   * per client (SIGN-05).
   */
  getSigningKey(keyId: string): Promise<CryptoKey | null>
  /** The key ID a client should currently sign with (newest in the rotation window). */
  getCurrentKeyId(clientId: string): Promise<string>
}
