import { describe, it, expect } from 'vitest'
import { computeTokenBucket } from './tokenBucket.js'

const spec = { capacity: 5, refillPerSecond: 1 }

describe('computeTokenBucket', () => {
  it('starts full for an unseen key (null state)', () => {
    const { decision, next } = computeTokenBucket(null, 1, spec, 1000)
    expect(decision.allowed).toBe(true)
    expect(decision.remaining).toBe(4)
    expect(next.tokens).toBe(4)
    expect(next.lastRefillMs).toBe(1000)
  })

  it('denies when cost exceeds available tokens, leaving tokens unchanged', () => {
    const state = { tokens: 2, lastRefillMs: 1000 }
    const { decision, next } = computeTokenBucket(state, 3, spec, 1000)
    expect(decision.allowed).toBe(false)
    expect(decision.remaining).toBe(2) // unchanged
    expect(next.tokens).toBe(2)
    expect(decision.retryAfterSeconds).toBe(1) // need 1 more token at 1/sec
  })

  it('refills continuously, clamped to capacity', () => {
    const state = { tokens: 0, lastRefillMs: 1000 }
    // 10s later → +10 tokens but clamped to capacity 5.
    const { decision, next } = computeTokenBucket(state, 1, spec, 11000)
    expect(next.tokens).toBe(4) // 5 refilled - 1 consumed
    expect(decision.allowed).toBe(true)
  })

  it('refills fractionally over partial seconds', () => {
    const state = { tokens: 0, lastRefillMs: 1000 }
    const { decision } = computeTokenBucket(state, 1, spec, 1500) // +0.5 token
    expect(decision.allowed).toBe(false) // 0.5 < 1
    expect(decision.retryAfterSeconds).toBe(1) // ceil(0.5 / 1)
  })

  it('computes resetAt as time-to-full', () => {
    const state = { tokens: 0, lastRefillMs: 1000 }
    const { decision } = computeTokenBucket(state, 0, spec, 1000) // observe only
    // deficit 5, refill 1/sec → 5s to full → resetAt = 1000 + 5000.
    expect(decision.resetAt).toBe(6000)
  })

  it('treats zero refill as a non-replenishing bucket', () => {
    const noRefill = { capacity: 3, refillPerSecond: 0 }
    const state = { tokens: 0, lastRefillMs: 1000 }
    const { decision } = computeTokenBucket(state, 1, noRefill, 99999)
    expect(decision.allowed).toBe(false)
    expect(decision.resetAt).toBe(Infinity)
    expect(decision.retryAfterSeconds).toBe(Infinity)
  })

  it('matches the conformance allow-then-deny accounting', () => {
    let state = { tokens: spec.capacity, lastRefillMs: 0 }
    for (let i = 0; i < 5; i++) {
      const { decision, next } = computeTokenBucket(state, 1, spec, 0)
      expect(decision.allowed).toBe(true)
      expect(decision.remaining).toBe(5 - (i + 1))
      state = next
    }
    const denied = computeTokenBucket(state, 1, spec, 0)
    expect(denied.decision.allowed).toBe(false)
    expect(denied.decision.remaining).toBe(0)
  })
})
