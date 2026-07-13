/**
 * Narrow structural ports for the Redis-backed stores (ARCH-01).
 *
 * The stores never import `ioredis` / `node-redis` — they depend ONLY on the
 * minimal {@link RedisPort} defined here, which exposes exactly the operations
 * the four stores need and nothing more. Two implementations satisfy it:
 *
 *   - {@link createRedisPort} — the REAL port, mapping each op onto an
 *     ioredis-style client ({@link RedisClientLike}) so the package typechecks
 *     and is publishable WITHOUT the SDK installed; the consumer passes their
 *     real client.
 *   - {@link createFakeRedisPort} — an in-process port over a `Map`, honoring the
 *     SAME atomicity contract synchronously (single JS tick == atomic, like the
 *     security-core memory stores). It backs the conformance suites.
 *
 * Atomicity contract the port guarantees (and the conformance suite asserts):
 *   - `setNx` is atomic first-write-wins (→ NonceStore exactly-once).
 *   - `eval` runs the whole token-bucket script atomically (→ RateLimitStore
 *     no-overspend). Real Redis runs `EVAL` server-side; the fake runs the
 *     equivalent JS computation in a single synchronous section.
 */

import {
  bucketTtlMillis,
  computeTokenBucket,
  TOKEN_BUCKET_LUA,
} from './tokenBucket.js'
import type { RateDecision, TokenBucketSpec } from '@smithy-hono/security-core/storage'

// ---------------------------------------------------------------------------
// RedisPort — the only surface the stores depend on.
// ---------------------------------------------------------------------------

/** Options for {@link RedisPort.set}. */
export interface SetOptions {
  /** Set a TTL in milliseconds (`PX`). */
  pxMillis?: number
  /** Only set if the key does not already exist (`NX`). */
  ifNotExists?: boolean
}

/**
 * The minimal Redis surface the stores use. Implementations MUST preserve the
 * atomicity of `set` with `ifNotExists` (SET NX) and of `evalTokenBucket`.
 */
export interface RedisPort {
  /** `GET key` → value or `null`. */
  get(key: string): Promise<string | null>
  /**
   * `SET key value [PX ms] [NX]`. Returns `true` if the value was written,
   * `false` only when `ifNotExists` was requested and the key already existed.
   */
  set(key: string, value: string, opts?: SetOptions): Promise<boolean>
  /** `DEL key`. Idempotent. */
  del(key: string): Promise<void>
  /** `PEXPIRE key ms`. No-op semantics if the key is gone. */
  pexpire(key: string, ms: number): Promise<void>
  /**
   * Atomically evaluate the token-bucket script against `key`. Bundled as a
   * first-class op (rather than a raw `eval`) so the fake and real ports share
   * the exact decision math via {@link computeTokenBucket} / the mirrored Lua.
   */
  evalTokenBucket(
    key: string,
    cost: number,
    spec: TokenBucketSpec,
    nowMs: number,
  ): Promise<RateDecision>
}

// ---------------------------------------------------------------------------
// RedisClientLike — the structural ioredis-style client the consumer supplies.
// ---------------------------------------------------------------------------

/**
 * The structural client {@link createRedisPort} maps onto. An `ioredis` client
 * satisfies this as-is; `node-redis` (v4) satisfies it with a thin shim
 * (its `set` returns `'OK' | null` and uses an options object — wrap it).
 *
 * Commands used: `GET`, `SET` (with `PX` and `NX`), `DEL`, `PEXPIRE`, `EVAL`.
 */
export interface RedisClientLike {
  get(key: string): Promise<string | null>
  /**
   * ioredis variadic `SET`: `set(key, value, 'PX', ms, 'NX')`. The variadic
   * args carry the optional `PX <ms>` and `NX` tokens. Returns `'OK'` on a
   * successful write or `null` when an `NX` set was skipped.
   */
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>
  del(key: string): Promise<number>
  pexpire(key: string, ms: number): Promise<number>
  /** ioredis `EVAL`: `eval(script, numKeys, key, ...args)`. */
  eval(
    script: string,
    numKeys: number,
    ...keysAndArgs: (string | number)[]
  ): Promise<unknown>
}

// ---------------------------------------------------------------------------
// Real port — over RedisClientLike (no SDK import).
// ---------------------------------------------------------------------------

/** Map the Lua flat-array reply (with -1 sentinels for Infinity) back to a RateDecision. */
function decodeBucketReply(reply: unknown): RateDecision {
  if (!Array.isArray(reply) || reply.length < 4) {
    throw new Error('adapter-node: malformed token-bucket EVAL reply')
  }
  const allowed = Number(reply[0]) === 1
  const remaining = Number(reply[1])
  const resetRaw = Number(reply[2])
  const retryRaw = Number(reply[3])
  return {
    allowed,
    remaining,
    resetAt: resetRaw < 0 ? Infinity : resetRaw,
    retryAfterSeconds: retryRaw < 0 ? Infinity : retryRaw,
  }
}

/**
 * Build the REAL {@link RedisPort} over a structural ioredis-style client.
 * Production wiring: `createRedisPort(new Redis(process.env.REDIS_URL))`.
 *
 * The token-bucket path runs {@link TOKEN_BUCKET_LUA} via `EVAL`, which mirrors
 * {@link computeTokenBucket}; running inside a single `EVAL` is what makes the
 * read-modify-write atomic (strong consistency, no overspend). `set` with
 * `ifNotExists` emits `SET ... NX` (atomic first-write-wins for the NonceStore).
 */
export function createRedisPort(client: RedisClientLike): RedisPort {
  return {
    async get(key) {
      return client.get(key)
    },
    async set(key, value, opts) {
      const args: (string | number)[] = []
      if (opts?.pxMillis !== undefined) args.push('PX', Math.ceil(opts.pxMillis))
      if (opts?.ifNotExists) args.push('NX')
      const reply = await client.set(key, value, ...args)
      // ioredis returns null when an NX set was skipped (key existed).
      return reply !== null
    },
    async del(key) {
      await client.del(key)
    },
    async pexpire(key, ms) {
      await client.pexpire(key, Math.ceil(ms))
    },
    async evalTokenBucket(key, cost, spec, nowMs) {
      const reply = await client.eval(
        TOKEN_BUCKET_LUA,
        1,
        key,
        cost,
        spec.capacity,
        spec.refillPerSecond,
        Math.floor(nowMs),
        bucketTtlMillis(spec),
      )
      return decodeBucketReply(reply)
    },
  }
}

// ---------------------------------------------------------------------------
// Fake port — in-process Map, same atomicity synchronously.
// ---------------------------------------------------------------------------

interface FakeEntry {
  value: string
  /** Idle/TTL expiry epoch millis, or `Infinity` for no TTL. */
  expiresAt: number
}

interface FakeBucket {
  tokens: number
  lastRefill: number
  /** Idle expiry epoch millis, mirroring the server-side PEXPIRE on the bucket key. */
  expiresAt: number
}

/** Current time hook (overridable in tests if ever needed). */
const fakeNow = (): number => Date.now()

/**
 * An in-process {@link RedisPort} backed by a `Map`. Each method's
 * read-modify-write runs in one synchronous section before the returned promise
 * settles, so — exactly like the security-core memory stores — there is no
 * interleaving and the atomicity contract holds under JS's single thread. This
 * validates ALL adapter logic and the atomicity invariant locally; the real Lua
 * / SET-NX against a live server is validated in Part D CI.
 */
export function createFakeRedisPort(): RedisPort {
  const kv = new Map<string, FakeEntry>()
  const buckets = new Map<string, FakeBucket>()

  const live = (key: string): FakeEntry | undefined => {
    const e = kv.get(key)
    if (!e) return undefined
    if (e.expiresAt <= fakeNow()) {
      kv.delete(key)
      return undefined
    }
    return e
  }

  return {
    async get(key) {
      return live(key)?.value ?? null
    },
    async set(key, value, opts) {
      const existing = live(key)
      if (opts?.ifNotExists && existing) return false // NX: key present → skip.
      const expiresAt =
        opts?.pxMillis !== undefined ? fakeNow() + opts.pxMillis : Infinity
      kv.set(key, { value, expiresAt })
      return true
    },
    async del(key) {
      kv.delete(key)
    },
    async pexpire(key, ms) {
      const e = live(key)
      if (e) e.expiresAt = fakeNow() + ms
    },
    async evalTokenBucket(key, cost, spec, nowMs) {
      // Single synchronous read-modify-write == atomic EVAL equivalent.
      // Mirror the server-side PEXPIRE so idle buckets self-evict: a bucket whose
      // TTL has lapsed since its last write is treated as absent (fresh full
      // bucket), and stale entries are dropped lazily on read — so the map is
      // bounded by the set of ACTIVE rate keys, not every key ever seen.
      const existing = buckets.get(key)
      const prev = existing && existing.expiresAt > nowMs ? existing : undefined
      if (existing && prev === undefined) buckets.delete(key)
      const { decision, state } = computeTokenBucket(prev, cost, spec, nowMs)
      buckets.set(key, { ...state, expiresAt: nowMs + bucketTtlMillis(spec) })
      return decision
    },
  }
}
