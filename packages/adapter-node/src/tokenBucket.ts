/**
 * Pure token-bucket math — the SINGLE source of truth for rate-limit accounting.
 *
 * Both the Redis Lua script (production, run inside an atomic `EVAL`) and the
 * in-process fake port (conformance) drive the SAME arithmetic; neither
 * reimplements it independently. The Lua in {@link TOKEN_BUCKET_LUA} is a
 * line-for-line mirror of this function — see the cross-reference comment there —
 * so the two cannot silently diverge. This keeps the strong-consistency invariant
 * (no overspend) identical across backends and lets the math be unit-tested
 * directly without any storage.
 *
 * The algorithm mirrors `MemoryRateLimitStore` / `computeTokenBucket` in
 * security-core's reference: a continuous (fractional) refill since the last
 * observation, clamped to capacity, then a decrement by `cost` iff enough tokens
 * are present.
 */

import type { RateDecision, TokenBucketSpec } from '@smithy-hono/security-core/storage'

/** Persisted bucket state between consume calls. */
export interface BucketState {
  /** Current token count (fractional). */
  tokens: number
  /** Epoch millis of the last refill computation. */
  lastRefill: number
}

/** The result of one pure `consume` evaluation: the decision plus the next state. */
export interface TokenBucketResult {
  decision: RateDecision
  state: BucketState
}

/**
 * Upper bound on the elapsed window credited in a single refill step (millis).
 * A bucket that has been full and idle for this long is indistinguishable from a
 * fresh (full) one, so capping never changes a correct decision — it only bounds
 * a clock-skew episode (a wildly-fast/skewed clock) to at most one full refill
 * instead of an unbounded over-credit. 1 hour is long enough to refill any sane
 * bucket. Mirrors `MAX_ELAPSED_MS` in adapter-aws's CAS path.
 */
const MAX_ELAPSED_MS = 60 * 60 * 1000

/**
 * Clamp `nowMs` to be skew-robust against the bucket's prior `lastRefill`: never
 * earlier than the last refill (no backward rewind → no over-throttle / stuck
 * bucket), and never more than {@link MAX_ELAPSED_MS} past it (cap the credited
 * elapsed → no unbounded over-credit). A fresh bucket (no prior) is left as-is.
 *
 * On the Redis path the authoritative clock is `redis.call('TIME')` (one shared
 * clock per logical bucket — see {@link TOKEN_BUCKET_LUA}); this clamp is the
 * mirrored defense for any path that still threads a caller `nowMs`.
 */
function clampNow(nowMs: number, lastRefill: number, fresh: boolean): number {
  if (fresh) return nowMs
  return Math.min(Math.max(nowMs, lastRefill), lastRefill + MAX_ELAPSED_MS)
}

/**
 * Evaluate one `consume(cost)` against a token bucket.
 *
 * @param prev  the persisted bucket state, or `undefined` for a fresh key (which
 *              starts full at `spec.capacity`).
 * @param cost  tokens this request wants (RATE-07 per-op cost).
 * @param spec  bucket capacity + refill rate.
 * @param nowMs current time (epoch millis); injected so the math is deterministic
 *              and testable.
 * @returns the {@link RateDecision} and the next {@link BucketState} to persist.
 */
export function computeTokenBucket(
  prev: BucketState | undefined,
  cost: number,
  spec: TokenBucketSpec,
  nowMs: number,
): TokenBucketResult {
  let tokens = prev ? prev.tokens : spec.capacity
  const lastRefill = prev ? prev.lastRefill : nowMs

  // Skew-robust clock: never rewind below the prior refill and never credit more
  // than MAX_ELAPSED_MS in one step. With a single shared clock (Redis TIME) this
  // is a no-op; with a skewed caller clock it bounds the anomaly to one refill.
  const now = clampNow(nowMs, lastRefill, prev === undefined)

  // Continuous refill since the last observation, clamped to capacity.
  const elapsedSeconds = (now - lastRefill) / 1000
  if (elapsedSeconds > 0) {
    tokens = Math.min(spec.capacity, tokens + elapsedSeconds * spec.refillPerSecond)
  }

  const allowed = tokens >= cost
  if (allowed) tokens -= cost

  // Time until the bucket is full again.
  const deficit = spec.capacity - tokens
  const secondsToFull =
    spec.refillPerSecond > 0 ? deficit / spec.refillPerSecond : Infinity
  const resetAt =
    secondsToFull === Infinity ? Infinity : now + Math.ceil(secondsToFull * 1000)

  // When denied, how long until enough tokens accrue for this cost.
  let retryAfterSeconds = 0
  if (!allowed) {
    const needed = cost - tokens
    retryAfterSeconds =
      spec.refillPerSecond > 0 ? Math.ceil(needed / spec.refillPerSecond) : Infinity
  }

  return {
    decision: {
      allowed,
      remaining: Math.max(0, Math.floor(tokens)),
      resetAt,
      retryAfterSeconds,
    },
    state: { tokens, lastRefill: now },
  }
}

/**
 * TTL (millis) to attach to a bucket key so idle buckets self-evict. A bucket
 * that has been full and untouched for this long is indistinguishable from a
 * fresh (full) bucket, so dropping it loses no accounting. We use the time to
 * refill from empty to full, plus a small floor for the degenerate
 * `refillPerSecond <= 0` case (a bucket that never refills must persist).
 */
export function bucketTtlMillis(spec: TokenBucketSpec): number {
  if (spec.refillPerSecond <= 0) {
    // Never refills — keep it around a long time so the spend sticks.
    return 24 * 60 * 60 * 1000
  }
  const secondsToFull = spec.capacity / spec.refillPerSecond
  // +1s floor so a tiny bucket never gets a sub-second eviction window.
  return Math.ceil((secondsToFull + 1) * 1000)
}

/**
 * The atomic token-bucket Lua script for Redis `EVAL`.
 *
 * KEYS[1] = bucket key (a Redis hash with fields `tokens`, `lastRefill`).
 * ARGV[1] = cost            (number)
 * ARGV[2] = capacity        (number)
 * ARGV[3] = refillPerSecond (number)
 * ARGV[4] = nowMs           (caller epoch millis — NOT the bucket clock, see below)
 * ARGV[5] = ttlMs           (key PEXPIRE, integer)
 *
 * Returns a flat array: { allowed(0|1), remaining, resetAtOrNeg1, retryAfterOrNeg1 }
 * where -1 encodes `Infinity` (the caller maps it back). Running inside a single
 * `EVAL` makes the whole read-modify-write atomic on the Redis server, so
 * concurrent callers can never overspend a bucket (strong consistency).
 *
 * SERVER CLOCK (STORES-ATOMICITY-03): the refill clock is sourced from the Redis
 * server itself via `redis.call('TIME')`, NOT from the caller's `ARGV[4]`. A
 * single logical bucket lives on one Redis server, so every caller — regardless
 * of its own `Date.now()` skew — shares that one monotonic clock; this eliminates
 * the cross-isolate over-credit/over-throttle that a caller-supplied clock caused.
 * As defense-in-depth (e.g. a replica failover whose clock differs), the same
 * never-rewind + cap-credited-elapsed clamp the pure path applies is mirrored
 * here against the stored `lastRefill`. `ARGV[4]` is retained for wire-compat but
 * is no longer the bucket clock.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MIRRORS {@link computeTokenBucket} EXACTLY. If you change one, change the other.
 * Line correspondences:
 *   tokens = prev ? prev.tokens : spec.capacity          ⇄  tokens = hget tokens or capacity
 *   lastRefill = prev ? prev.lastRefill : now            ⇄  lastRefill = hget lastRefill or now
 *   skew clamp: never-rewind + cap-credited-elapsed      ⇄  same (clamp `now`)
 *   elapsed refill, clamp to capacity                    ⇄  same
 *   allowed = tokens >= cost ; if allowed tokens -= cost ⇄  same
 *   resetAt / retryAfterSeconds (Infinity → -1)          ⇄  same
 *   persist {tokens,lastRefill} + PEXPIRE ttl            ⇄  hset + pexpire
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local cost = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refill = tonumber(ARGV[3])
local ttl = tonumber(ARGV[5])

-- Bucket clock = the Redis server clock, shared by every caller of this bucket
-- (STORES-ATOMICITY-03). ARGV[4] (caller Date.now) is intentionally NOT used.
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local data = redis.call('HMGET', key, 'tokens', 'lastRefill')
local fresh = true
local tokens = capacity
local lastRefill = now
if data[1] then tokens = tonumber(data[1]) end
if data[2] then
  lastRefill = tonumber(data[2])
  fresh = false
end

-- Skew-robust clamp (defense-in-depth, mirrors computeTokenBucket): never rewind
-- below the prior refill and never credit more than MAX_ELAPSED_MS in one step.
local MAX_ELAPSED_MS = 60 * 60 * 1000
if not fresh then
  if now < lastRefill then now = lastRefill end
  if now > lastRefill + MAX_ELAPSED_MS then now = lastRefill + MAX_ELAPSED_MS end
end

local elapsed = (now - lastRefill) / 1000
if elapsed > 0 then
  tokens = math.min(capacity, tokens + elapsed * refill)
end

local allowed = 0
if tokens >= cost then
  allowed = 1
  tokens = tokens - cost
end

local deficit = capacity - tokens
local resetAt = -1
if refill > 0 then
  resetAt = now + math.ceil((deficit / refill) * 1000)
end

local retryAfter = 0
if allowed == 0 then
  if refill > 0 then
    retryAfter = math.ceil((cost - tokens) / refill)
  else
    retryAfter = -1
  end
end

redis.call('HSET', key, 'tokens', tostring(tokens), 'lastRefill', tostring(now))
redis.call('PEXPIRE', key, ttl)

local remaining = math.floor(tokens)
if remaining < 0 then remaining = 0 end
return { allowed, remaining, resetAt, retryAfter }
`
