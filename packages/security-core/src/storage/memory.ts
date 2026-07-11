/**
 * In-memory dev-only implementations of the four storage interfaces.
 *
 * ⚠️  DEV / SINGLE-PROCESS ONLY (ARCH-02). These keep state in a plain `Map` in
 * the current process. They are **meaningless on Workers isolates / Lambda
 * containers** — each isolate/container has its own copy, so there is no
 * cross-request consistency, no shared rate-limit accounting, and no replay
 * protection across instances. They exist solely so `examples/todo-api` and unit
 * tests can run without external backends. Production uses the Phase S10 adapter
 * packages (Durable Objects / Redis / DynamoDB-CAS / Secrets Manager).
 *
 * Within a single process they are correct and (because JS runs the async bodies
 * to completion without interleaving synchronous sections) strongly consistent,
 * which is what lets them pass the shared conformance suite.
 */

import type {
  NonceStore,
  RateDecision,
  RateLimitStore,
  SecretProvider,
  SessionRecord,
  SessionStore,
  TokenBucketSpec,
} from './index.js'

const nowMs = (): number => Date.now()

// ---------------------------------------------------------------------------
// MemorySessionStore
// ---------------------------------------------------------------------------

interface StoredSession {
  rec: SessionRecord
  /** Idle-TTL expiry, epoch millis. */
  expiresAt: number
}

/**
 * Dev-only in-memory {@link SessionStore}. Single-process only (ARCH-02).
 */
export class MemorySessionStore implements SessionStore {
  private readonly map = new Map<string, StoredSession>()

  async get(sessionId: string): Promise<SessionRecord | null> {
    const entry = this.map.get(sessionId)
    if (!entry) return null
    // Idle-TTL or absolute-expiry lapse → treat as gone (lazy eviction).
    if (entry.expiresAt <= nowMs() || entry.rec.absoluteExpiry <= nowMs()) {
      this.map.delete(sessionId)
      return null
    }
    return entry.rec
  }

  async set(sessionId: string, rec: SessionRecord, ttlSeconds: number): Promise<void> {
    this.map.set(sessionId, { rec, expiresAt: nowMs() + ttlSeconds * 1000 })
  }

  async delete(sessionId: string): Promise<void> {
    this.map.delete(sessionId)
  }

  async touch(sessionId: string, idleTtlSeconds: number): Promise<void> {
    const entry = this.map.get(sessionId)
    if (!entry) return
    if (entry.rec.absoluteExpiry <= nowMs()) {
      this.map.delete(sessionId)
      return
    }
    entry.expiresAt = nowMs() + idleTtlSeconds * 1000
  }
}

// ---------------------------------------------------------------------------
// MemoryRateLimitStore
// ---------------------------------------------------------------------------

interface Bucket {
  tokens: number
  /** Epoch millis of the last refill computation. */
  lastRefill: number
  /** Capacity of the spec last seen for this key (for idle-prune detection). */
  capacity: number
  /** Refill rate (tokens/sec) of the spec last seen, for idle-prune detection. */
  refillPerSecond: number
}

/**
 * Dev-only in-memory {@link RateLimitStore} using a continuous token bucket.
 * Single-process only (ARCH-02) — a real deployment needs a strongly-consistent
 * shared backend so concurrent isolates can't overspend a bucket.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>()

  /**
   * Lazy-prune threshold: only scan for fully-idle buckets once the Map grows
   * past this many keys, keeping per-call cost O(1) amortized (ARCH-02 dev-only).
   */
  private static readonly PRUNE_THRESHOLD = 1024

  /**
   * Drop fully-refilled (idle) buckets — a bucket that has refilled back to its
   * capacity is indistinguishable from a fresh one, so deleting it is
   * behavior-preserving. Gated on a size threshold so the O(n) sweep is
   * amortized away (ARCH-02 dev-only self-bounding).
   */
  private pruneIdle(now: number, except: string): void {
    if (this.buckets.size <= MemoryRateLimitStore.PRUNE_THRESHOLD) return
    for (const [k, b] of this.buckets) {
      if (k === except) continue
      const elapsed = (now - b.lastRefill) / 1000
      const refilled =
        elapsed > 0 ? Math.min(b.capacity, b.tokens + elapsed * b.refillPerSecond) : b.tokens
      if (refilled >= b.capacity) this.buckets.delete(k)
    }
  }

  async consume(key: string, cost: number, limit: TokenBucketSpec): Promise<RateDecision> {
    const now = nowMs()
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = {
        tokens: limit.capacity,
        lastRefill: now,
        capacity: limit.capacity,
        refillPerSecond: limit.refillPerSecond,
      }
      this.buckets.set(key, bucket)
    } else {
      // Track the latest spec so idle-prune can detect a fully-refilled bucket.
      bucket.capacity = limit.capacity
      bucket.refillPerSecond = limit.refillPerSecond
    }

    // Lazily evict fully-idle buckets to keep the Map bounded (dev-only).
    this.pruneIdle(now, key)

    // Continuous refill since the last observation, clamped to capacity.
    const elapsedSeconds = (now - bucket.lastRefill) / 1000
    if (elapsedSeconds > 0) {
      bucket.tokens = Math.min(
        limit.capacity,
        bucket.tokens + elapsedSeconds * limit.refillPerSecond,
      )
      bucket.lastRefill = now
    }

    const allowed = bucket.tokens >= cost
    if (allowed) bucket.tokens -= cost

    // Time until the bucket is full again.
    const deficit = limit.capacity - bucket.tokens
    const secondsToFull =
      limit.refillPerSecond > 0 ? deficit / limit.refillPerSecond : Infinity
    const resetAt =
      secondsToFull === Infinity ? Infinity : now + Math.ceil(secondsToFull * 1000)

    // When denied, how long until enough tokens accrue for this cost.
    let retryAfterSeconds = 0
    if (!allowed) {
      const needed = cost - bucket.tokens
      retryAfterSeconds =
        limit.refillPerSecond > 0 ? Math.ceil(needed / limit.refillPerSecond) : Infinity
    }

    return {
      allowed,
      remaining: Math.max(0, Math.floor(bucket.tokens)),
      resetAt,
      retryAfterSeconds,
    }
  }
}

// ---------------------------------------------------------------------------
// MemoryNonceStore
// ---------------------------------------------------------------------------

/**
 * Dev-only in-memory {@link NonceStore}. Single-process only (ARCH-02) — replay
 * defense across instances needs a strongly-consistent shared backend.
 */
export class MemoryNonceStore implements NonceStore {
  /** nonce → expiry epoch millis. */
  private readonly seen = new Map<string, number>()

  /**
   * Lazy-prune threshold: only sweep expired nonces once the Map grows past this
   * many keys, keeping per-call cost O(1) amortized (ARCH-02 dev-only).
   */
  private static readonly PRUNE_THRESHOLD = 1024

  /** Delete all expired seen-nonce entries (gated on a size threshold). */
  private pruneExpired(now: number): void {
    if (this.seen.size <= MemoryNonceStore.PRUNE_THRESHOLD) return
    for (const [n, expiry] of this.seen) {
      if (expiry <= now) this.seen.delete(n)
    }
  }

  async checkAndStore(nonce: string, ttlSeconds: number): Promise<boolean> {
    const now = nowMs()
    const existing = this.seen.get(nonce)
    if (existing !== undefined && existing > now) {
      return false // replay within window
    }
    // Expired hot entry → drop it before re-recording (keeps the key clean).
    if (existing !== undefined) this.seen.delete(nonce)
    // Bound total size against churning distinct nonces (lazy eviction).
    this.pruneExpired(now)
    // First-write-wins: record the fresh window.
    this.seen.set(nonce, now + ttlSeconds * 1000)
    return true
  }
}

// ---------------------------------------------------------------------------
// MemorySecretProvider
// ---------------------------------------------------------------------------

/**
 * Dev-only in-memory {@link SecretProvider}. Single-process only (ARCH-02) — real
 * deployments resolve keys from Secrets Manager / Workers secrets / k8s, never
 * from in-process config (SIGN-06). Provided here so signing tests/examples can
 * import pre-generated `CryptoKey`s.
 */
export class MemorySecretProvider implements SecretProvider {
  /** keyId → imported HMAC CryptoKey. */
  private readonly keys = new Map<string, CryptoKey>()
  /** clientId → current keyId. */
  private readonly currentKeyByClient = new Map<string, string>()

  /**
   * Register a signing key (test/dev helper, not part of the interface).
   * `current` marks it as the client's current key ID for rotation.
   */
  addKey(
    keyId: string,
    key: CryptoKey,
    opts?: { clientId?: string; current?: boolean },
  ): void {
    this.keys.set(keyId, key)
    if (opts?.clientId && opts.current) {
      this.currentKeyByClient.set(opts.clientId, keyId)
    }
  }

  async getSigningKey(keyId: string): Promise<CryptoKey | null> {
    return this.keys.get(keyId) ?? null
  }

  async getCurrentKeyId(clientId: string): Promise<string> {
    const id = this.currentKeyByClient.get(clientId)
    if (id === undefined) {
      throw new Error(`No current signing key registered for client '${clientId}'`)
    }
    return id
  }
}
