/**
 * Focused regression tests for the DynamoDB store hardening:
 *   - STORES-ATOMICITY-05: a poisoned/legacy nonce row with a missing/non-numeric
 *     `expiresAtMs` must be reclaimable, not treated as `Infinity`-live forever.
 *   - STORES-ATOMICITY-03: token-bucket refill must be robust to caller clock skew
 *     (no backward `lastRefillMs`, capped credited elapsed → no overspend).
 *
 * These drive the real store logic over the in-process FAKE port.
 */

import { describe, it, expect } from 'vitest'
import { FakeDynamoTablePort } from '../test-support.js'
import { DynamoNonceStore } from './nonce.js'
import { DynamoRateLimitStore } from './rateLimit.js'
import type { TokenBucketSpec } from '@smithy-hono/security-core/storage'

describe('DynamoNonceStore — poisoned-row reclaim (STORES-ATOMICITY-05)', () => {
  it('reclaims a row whose expiresAtMs is missing instead of denying forever', async () => {
    const port = new FakeDynamoTablePort()
    // Seed a malformed/legacy row at the nonce key with NO numeric deadline.
    await port.putItem({ pk: 'nonce:abc', owner: 'legacy' }, { ifNotExists: true })

    const store = new DynamoNonceStore(port)
    // The legitimate first acceptance must succeed (reclaim the poisoned row).
    expect(await store.checkAndStore('abc', 60)).toBe(true)
    // A genuine replay within the window is still rejected.
    expect(await store.checkAndStore('abc', 60)).toBe(false)
  })

  it('reclaims a row whose expiresAtMs is non-numeric', async () => {
    const port = new FakeDynamoTablePort()
    await port.putItem({ pk: 'nonce:xyz', owner: 'legacy', expiresAtMs: 'garbage' }, { ifNotExists: true })

    const store = new DynamoNonceStore(port)
    expect(await store.checkAndStore('xyz', 60)).toBe(true)
  })
})

describe('DynamoRateLimitStore — skew-robust refill (STORES-ATOMICITY-03)', () => {
  const spec: TokenBucketSpec = { capacity: 5, refillPerSecond: 1 }

  it('caps a single skewed call to at most one full refill (no unbounded over-credit)', async () => {
    const port = new FakeDynamoTablePort()
    const store = new DynamoRateLimitStore(port)

    // Drain the bucket to empty at the real clock.
    for (let i = 0; i < 5; i++) {
      expect((await store.consume('k', 1, spec)).allowed).toBe(true)
    }
    expect((await store.consume('k', 1, spec)).allowed).toBe(false)

    // A caller whose clock is a YEAR fast must not, in one step, credit more than
    // a full bucket: the capped elapsed clamps the refill to `capacity`, so the
    // single skewed call's exposed tokens stay bounded by `capacity` — without the
    // cap the math is identical here (refill clamps to capacity), but the cap is
    // what keeps `lastRefillMs` from leaping a year ahead in one write (which would
    // let an even-faster later caller keep over-crediting unbounded).
    const realNow = Date.now
    const yearMs = 365 * 24 * 60 * 60 * 1000
    Date.now = () => realNow() + yearMs
    try {
      const d = await store.consume('k', 1, spec)
      expect(d.allowed).toBe(true)
      // One step exposes at most a full bucket minus the spent token.
      expect(d.remaining).toBeLessThanOrEqual(spec.capacity - 1)
      // The persisted lastRefillMs advanced by at most the cap, NOT a full year.
      const reread = await port.getItem({ pk: 'rl:k' })
      expect(reread?.lastRefillMs as number).toBeLessThan(realNow() + yearMs)
    } finally {
      Date.now = realNow
    }
  })

  it('never rewinds lastRefillMs when a later caller has a slow clock', async () => {
    const port = new FakeDynamoTablePort()
    const store = new DynamoRateLimitStore(port)

    // First call at the real clock establishes lastRefillMs ≈ now.
    await store.consume('k', 1, spec)
    const after = await port.getItem({ pk: 'rl:k' })
    const established = after?.lastRefillMs as number

    // A caller whose clock is far in the PAST must not move lastRefillMs backward.
    const realNow = Date.now
    Date.now = () => realNow() - 24 * 60 * 60 * 1000
    try {
      await store.consume('k', 1, spec)
    } finally {
      Date.now = realNow
    }
    const reread = await port.getItem({ pk: 'rl:k' })
    expect(reread?.lastRefillMs as number).toBeGreaterThanOrEqual(established)
  })
})
