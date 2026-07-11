/**
 * Unit tests for the pure token-bucket math — the single source of truth that
 * the Lua script mirrors. Tested directly, no storage.
 */

import { describe, it, expect } from 'vitest'
import { computeTokenBucket, bucketTtlMillis } from './tokenBucket.js'

const spec = { capacity: 5, refillPerSecond: 1 }

describe('computeTokenBucket', () => {
  it('starts a fresh key full at capacity', () => {
    const { decision, state } = computeTokenBucket(undefined, 1, spec, 1000)
    expect(decision.allowed).toBe(true)
    expect(decision.remaining).toBe(4)
    expect(state.tokens).toBe(4)
    expect(state.lastRefill).toBe(1000)
  })

  it('drains to empty then denies, leaving state unchanged on denial', () => {
    let state = computeTokenBucket(undefined, 5, spec, 1000).state
    expect(state.tokens).toBe(0)
    const denied = computeTokenBucket(state, 1, spec, 1000)
    expect(denied.decision.allowed).toBe(false)
    expect(denied.decision.remaining).toBe(0)
    expect(denied.decision.retryAfterSeconds).toBe(1)
    expect(denied.state.tokens).toBe(0) // no overspend below zero
  })

  it('refills continuously and clamps to capacity', () => {
    const drained = { tokens: 0, lastRefill: 1000 }
    // 2.5s later → 2.5 tokens.
    const mid = computeTokenBucket(drained, 0, spec, 3500)
    expect(mid.state.tokens).toBeCloseTo(2.5, 5)
    // 100s later → clamped at capacity 5.
    const full = computeTokenBucket(drained, 0, spec, 101000)
    expect(full.state.tokens).toBe(5)
  })

  it('honors per-call cost (RATE-07)', () => {
    const d = computeTokenBucket(undefined, 3, spec, 0)
    expect(d.decision.allowed).toBe(true)
    expect(d.decision.remaining).toBe(2)
    const denied = computeTokenBucket(d.state, 3, spec, 0)
    expect(denied.decision.allowed).toBe(false)
    expect(denied.decision.remaining).toBe(2)
  })

  it('encodes resetAt/retryAfter as Infinity when refill is zero', () => {
    const noRefill = { capacity: 2, refillPerSecond: 0 }
    const drained = computeTokenBucket(undefined, 2, noRefill, 0)
    expect(drained.decision.resetAt).toBe(Infinity)
    const denied = computeTokenBucket(drained.state, 1, noRefill, 0)
    expect(denied.decision.allowed).toBe(false)
    expect(denied.decision.retryAfterSeconds).toBe(Infinity)
  })

  it('computes retryAfterSeconds as ceil(needed/refill) when denied', () => {
    const drained = computeTokenBucket(undefined, 5, spec, 0)
    // need 2 more tokens at 1/sec → retryAfter 2.
    const denied = computeTokenBucket(drained.state, 2, spec, 0)
    expect(denied.decision.allowed).toBe(false)
    expect(denied.decision.retryAfterSeconds).toBe(2)
  })

  // STORES-ATOMICITY-03: a caller clock that disagrees with the bucket clock must
  // not corrupt accounting. The pure path clamps `now` (never rewind below the
  // prior refill; cap the credited elapsed) so a skew episode is bounded.
  describe('clock-skew robustness', () => {
    it('never rewinds lastRefill when a later caller has a slower clock', () => {
      // Fast-clock instance writes lastRefill far ahead of real time.
      const drained = { tokens: 0, lastRefill: 10_000 }
      // Slow-clock caller arrives "earlier" (now < lastRefill): no negative
      // refill, no over-throttle past the stored clock — and lastRefill holds.
      const r = computeTokenBucket(drained, 0, spec, 5_000)
      expect(r.state.tokens).toBe(0) // elapsed clamped to 0, no spurious credit
      expect(r.state.lastRefill).toBe(10_000) // monotonic: never moves backward
    })

    it('caps credited elapsed so a wildly-fast caller cannot over-credit', () => {
      // capacity 5, 1 token/sec. A caller whose clock is 10 hours ahead would
      // otherwise credit ~36000 tokens; the 1h cap keeps it bounded (still
      // clamps to capacity here, but the persisted clock is capped too).
      const drained = { tokens: 0, lastRefill: 1_000 }
      const tenHoursAhead = 1_000 + 10 * 60 * 60 * 1000
      const r = computeTokenBucket(drained, 0, spec, tenHoursAhead)
      expect(r.state.tokens).toBe(5) // clamped to capacity, not unbounded
      // Persisted clock advanced by at most MAX_ELAPSED_MS (1h), not 10h.
      expect(r.state.lastRefill).toBe(1_000 + 60 * 60 * 1000)
    })

    it('leaves a fresh bucket clock untouched (no prior to clamp against)', () => {
      const r = computeTokenBucket(undefined, 1, spec, 123_456)
      expect(r.state.lastRefill).toBe(123_456)
    })
  })
})

describe('bucketTtlMillis', () => {
  it('is the refill-from-empty time plus a 1s floor', () => {
    // capacity 5 at 1/sec → 5s to refill + 1s floor = 6000ms.
    expect(bucketTtlMillis(spec)).toBe(6000)
  })

  it('falls back to a long TTL for a non-refilling bucket', () => {
    expect(bucketTtlMillis({ capacity: 5, refillPerSecond: 0 })).toBe(24 * 60 * 60 * 1000)
  })
})
