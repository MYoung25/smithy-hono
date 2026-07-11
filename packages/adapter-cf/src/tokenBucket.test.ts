/**
 * Unit tests for the pure token-bucket math (single source of truth). Driven
 * directly with an injected clock — no storage, no DO.
 */

import { describe, it, expect } from 'vitest'
import { computeTokenBucket, type BucketState } from './tokenBucket.js'

const spec = { capacity: 5, refillPerSecond: 1 }

describe('computeTokenBucket', () => {
  it('starts a fresh key full at capacity', () => {
    const { decision, state } = computeTokenBucket(undefined, 1, spec, 1_000)
    expect(decision.allowed).toBe(true)
    expect(decision.remaining).toBe(4)
    expect(state.tokens).toBe(4)
    expect(state.lastRefill).toBe(1_000)
  })

  it('denies when cost exceeds available tokens and leaves state unchanged in tokens', () => {
    const prev: BucketState = { tokens: 2, lastRefill: 1_000 }
    const { decision, state } = computeTokenBucket(prev, 3, spec, 1_000)
    expect(decision.allowed).toBe(false)
    expect(decision.remaining).toBe(2) // not debited on denial
    expect(state.tokens).toBe(2)
    expect(decision.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('honors per-call cost (RATE-07)', () => {
    const { decision } = computeTokenBucket(undefined, 3, spec, 0)
    expect(decision.allowed).toBe(true)
    expect(decision.remaining).toBe(2)
  })

  it('refills continuously over elapsed time, clamped to capacity', () => {
    const prev: BucketState = { tokens: 0, lastRefill: 0 }
    // 3s later at 1/sec → 3 tokens back; consume 1 → 2 remaining.
    const { decision, state } = computeTokenBucket(prev, 1, spec, 3_000)
    expect(decision.allowed).toBe(true)
    expect(state.tokens).toBeCloseTo(2)
    // 100s later → clamps at capacity 5, not 100.
    const { state: full } = computeTokenBucket(state, 0, spec, 103_000)
    expect(full.tokens).toBe(5)
  })

  it('computes a finite resetAt when refilling and Infinity when never refilling', () => {
    const drained: BucketState = { tokens: 0, lastRefill: 1_000 }
    const { decision } = computeTokenBucket(drained, 0, spec, 1_000)
    expect(decision.resetAt).toBeGreaterThan(1_000)
    expect(Number.isFinite(decision.resetAt)).toBe(true)

    const noRefill = { capacity: 5, refillPerSecond: 0 }
    const d2 = computeTokenBucket({ tokens: 1, lastRefill: 0 }, 0, noRefill, 0).decision
    expect(d2.resetAt).toBe(Infinity)
  })

  it('retryAfterSeconds reflects time to accrue the deficit', () => {
    const drained: BucketState = { tokens: 0, lastRefill: 0 }
    const { decision } = computeTokenBucket(drained, 2, spec, 0)
    expect(decision.allowed).toBe(false)
    // need 2 tokens at 1/sec → 2s
    expect(decision.retryAfterSeconds).toBe(2)
  })
})
