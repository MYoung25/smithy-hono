/**
 * Pure token-bucket math — the SINGLE source of truth for rate-limit accounting.
 *
 * Both the Durable Object logic (production) and the in-process fake (conformance)
 * call {@link computeTokenBucket}; neither reimplements the arithmetic. This keeps
 * the strong-consistency invariant identical across backends and lets the math be
 * unit-tested directly without any storage.
 *
 * The algorithm mirrors `MemoryRateLimitStore` in security-core: a continuous
 * (fractional) refill since the last observation, clamped to capacity, then a
 * decrement by `cost` iff enough tokens are present.
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

  // Continuous refill since the last observation, clamped to capacity.
  const elapsedSeconds = (nowMs - lastRefill) / 1000
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
    secondsToFull === Infinity ? Infinity : nowMs + Math.ceil(secondsToFull * 1000)

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
    state: { tokens, lastRefill: nowMs },
  }
}
