/**
 * The four storage interfaces (ARCH-03) implemented over a {@link RedisPort}.
 *
 * Each store is constructed with a port (real or fake) and an optional key
 * prefix. Logic lives ONLY against the port — no `ioredis` import — so the same
 * store class passes the conformance suite against the in-process fake and runs
 * unchanged against real Redis in production.
 *
 * Strong consistency (locked decision, docs 00/07/08):
 *   - RateLimitStore → atomic token-bucket `EVAL` → exact, no overspend.
 *   - NonceStore     → `SET NX PX` first-write-wins → exactly-once accept.
 *   - SessionStore   → Redis is strongly consistent → sessions are exact (this is
 *     the contrast with eventually-consistent KV noted in the README).
 */

import type {
  NonceStore,
  RateDecision,
  RateLimitStore,
  SessionRecord,
  SessionStore,
  TokenBucketSpec,
} from '@smithy-hono/security-core/storage'
import type { RedisPort } from './ports.js'

const nowMs = (): number => Date.now()

/** Shared key-prefix option for every store (namespacing within a Redis db). */
export interface StoreOptions {
  /** Prefix prepended to every key, e.g. `'sess:'`. Default per-store. */
  prefix?: string
}

// ---------------------------------------------------------------------------
// RedisSessionStore
// ---------------------------------------------------------------------------

/**
 * On-disk shape of a session: the record plus its absolute-expiry ceiling so
 * `get`/`touch` can fail-closed past the cap even while the idle TTL is alive.
 * Redis enforces the idle TTL via `PX`; we enforce the absolute cap in code.
 */
interface StoredSession {
  rec: SessionRecord
}

/**
 * {@link SessionStore} over Redis. `set` writes JSON with a `PX` idle TTL; `get`
 * reads it (and fails closed past `absoluteExpiry`); `delete` is `DEL`; `touch`
 * slides the idle TTL via `PEXPIRE` (and tears down past the absolute cap).
 */
export class RedisSessionStore implements SessionStore {
  readonly #port: RedisPort
  readonly #prefix: string

  constructor(port: RedisPort, opts: StoreOptions = {}) {
    this.#port = port
    this.#prefix = opts.prefix ?? 'sess:'
  }

  #key(id: string): string {
    return this.#prefix + id
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    const raw = await this.#port.get(this.#key(sessionId))
    if (raw === null) return null
    const parsed = JSON.parse(raw) as StoredSession
    // Absolute-expiry ceiling (AUTH-05): never serve past it even if TTL is alive.
    if (parsed.rec.absoluteExpiry <= nowMs()) {
      await this.#port.del(this.#key(sessionId))
      return null
    }
    return parsed.rec
  }

  async set(sessionId: string, rec: SessionRecord, ttlSeconds: number): Promise<void> {
    const payload: StoredSession = { rec }
    await this.#port.set(this.#key(sessionId), JSON.stringify(payload), {
      pxMillis: ttlSeconds * 1000,
    })
  }

  async delete(sessionId: string): Promise<void> {
    await this.#port.del(this.#key(sessionId))
  }

  async touch(sessionId: string, idleTtlSeconds: number): Promise<void> {
    // No-op if gone (PEXPIRE on a missing key does nothing). Also fail-closed
    // past the absolute cap so a slid TTL can never revive an over-cap session.
    const raw = await this.#port.get(this.#key(sessionId))
    if (raw === null) return
    const parsed = JSON.parse(raw) as StoredSession
    if (parsed.rec.absoluteExpiry <= nowMs()) {
      await this.#port.del(this.#key(sessionId))
      return
    }
    await this.#port.pexpire(this.#key(sessionId), idleTtlSeconds * 1000)
  }
}

// ---------------------------------------------------------------------------
// RedisRateLimitStore
// ---------------------------------------------------------------------------

/**
 * {@link RateLimitStore} over Redis. Each `consume` is one atomic token-bucket
 * `EVAL` (see {@link RedisPort.evalTokenBucket}); Redis strong consistency means
 * concurrent callers cannot overspend a single logical bucket (RATE-01).
 */
export class RedisRateLimitStore implements RateLimitStore {
  readonly #port: RedisPort
  readonly #prefix: string

  constructor(port: RedisPort, opts: StoreOptions = {}) {
    this.#port = port
    this.#prefix = opts.prefix ?? 'rl:'
  }

  async consume(
    key: string,
    cost: number,
    limit: TokenBucketSpec,
  ): Promise<RateDecision> {
    return this.#port.evalTokenBucket(this.#prefix + key, cost, limit, nowMs())
  }
}

// ---------------------------------------------------------------------------
// RedisNonceStore
// ---------------------------------------------------------------------------

/**
 * {@link NonceStore} over Redis. `checkAndStore` is a single `SET key val NX PX`:
 * the write succeeds (→ `true`, accept) only if the nonce was unseen; an existing
 * key fails the `NX` (→ `false`, replay → reject). Atomic first-write-wins gives
 * exactly-once acceptance under concurrency (SIGN-03/10).
 */
export class RedisNonceStore implements NonceStore {
  readonly #port: RedisPort
  readonly #prefix: string

  constructor(port: RedisPort, opts: StoreOptions = {}) {
    this.#port = port
    this.#prefix = opts.prefix ?? 'nonce:'
  }

  async checkAndStore(nonce: string, ttlSeconds: number): Promise<boolean> {
    return this.#port.set(this.#prefix + nonce, '1', {
      ifNotExists: true,
      pxMillis: ttlSeconds * 1000,
    })
  }
}
