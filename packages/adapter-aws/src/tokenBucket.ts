/**
 * Pure token-bucket math (RATE-01/07) shared by the real DynamoDB CAS path and
 * the fake in-process port. Keeping the arithmetic in ONE place guarantees the
 * adapter computes identical decisions whether it runs against DynamoDB or the
 * fake — the conformance suite's no-overspend invariant therefore exercises the
 * exact code production uses.
 *
 * Mirrors the security-core `MemoryRateLimitStore` continuous-refill semantics
 * (see `security-core/src/storage/memory.ts`) so behavioral parity holds.
 */

import type { RateDecision, TokenBucketSpec } from '@smithy-hono/security-core/storage'

/** Persisted bucket state (the item body, minus pk/version/ttl). */
export interface BucketState {
  /** Tokens remaining as of {@link lastRefillMs}. */
  tokens: number
  /** Epoch millis of the last refill computation. */
  lastRefillMs: number
}

/** Result of one bucket evaluation: the decision plus the next state to persist. */
export interface BucketResult {
  decision: RateDecision
  next: BucketState
}

/**
 * Evaluate one `consume(cost)` against `state` at `nowMs`. Pure: no clocks, no
 * I/O. Returns the {@link RateDecision} and the next {@link BucketState} the
 * caller persists (conditionally, under CAS) when allowed OR denied — the
 * refill always advances `lastRefillMs`, so even a denied call writes back the
 * accrued tokens to keep the bucket monotonic.
 *
 * A `null` prior state means an unseen key → start full at `capacity`.
 */
export function computeTokenBucket(
  state: BucketState | null,
  cost: number,
  spec: TokenBucketSpec,
  nowMs: number,
): BucketResult {
  const prevTokens = state ? state.tokens : spec.capacity
  const lastRefill = state ? state.lastRefillMs : nowMs

  // Continuous refill since last observation, clamped to capacity.
  let tokens = prevTokens
  const elapsedSeconds = (nowMs - lastRefill) / 1000
  if (elapsedSeconds > 0) {
    tokens = Math.min(spec.capacity, tokens + elapsedSeconds * spec.refillPerSecond)
  }

  const allowed = tokens >= cost
  if (allowed) tokens -= cost

  // Time until the bucket is full again.
  const deficit = spec.capacity - tokens
  const secondsToFull = spec.refillPerSecond > 0 ? deficit / spec.refillPerSecond : Infinity
  const resetAt = secondsToFull === Infinity ? Infinity : nowMs + Math.ceil(secondsToFull * 1000)

  // When denied, seconds until enough tokens accrue for this cost.
  let retryAfterSeconds = 0
  if (!allowed) {
    const needed = cost - tokens
    retryAfterSeconds = spec.refillPerSecond > 0 ? Math.ceil(needed / spec.refillPerSecond) : Infinity
  }

  return {
    decision: {
      allowed,
      remaining: Math.max(0, Math.floor(tokens)),
      resetAt,
      retryAfterSeconds,
    },
    next: { tokens, lastRefillMs: nowMs },
  }
}
