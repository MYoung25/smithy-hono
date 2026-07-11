import { describe, it, expect } from 'vitest'
import { createFakeRedisPort } from './ports.js'
import type { TokenBucketSpec } from '@smithy-hono/security-core/storage'

describe('createFakeRedisPort token-bucket eviction (PEXPIRE mirror)', () => {
  it('treats a bucket idle past its TTL as fresh (self-evicts, mirroring PEXPIRE)', async () => {
    const port = createFakeRedisPort()
    // refillPerSecond:0 → the bucket NEVER refills, so without TTL eviction a
    // spent bucket would stay denied forever. bucketTtlMillis for a non-refilling
    // bucket is 24h, so after that window the entry must be dropped and re-created
    // full — proving eviction rather than refill.
    const spec: TokenBucketSpec = { capacity: 1, refillPerSecond: 0 }

    const first = await port.evalTokenBucket('k', 1, spec, 0)
    expect(first.allowed).toBe(true)

    // Same instant: no tokens left, and (refill 0) never will be. This write
    // stamps expiresAt = 0 + 24h (bucketTtlMillis for a non-refilling bucket).
    const denied = await port.evalTokenBucket('k', 1, spec, 0)
    expect(denied.allowed).toBe(false)

    // Past the TTL the idle bucket self-evicts → a fresh full bucket allows again
    // (a non-refilling bucket could only be allowed via eviction, not refill).
    const afterEvict = await port.evalTokenBucket('k', 1, spec, 24 * 60 * 60 * 1000 + 1)
    expect(afterEvict.allowed).toBe(true)
  })
})
