import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  MemorySessionStore,
  MemoryRateLimitStore,
  MemoryNonceStore,
  MemorySecretProvider,
} from './memory.js'
import {
  describeSessionStore,
  describeRateLimitStore,
  describeNonceStore,
} from './conformance.js'

// Run the dev in-memory implementations through the shared conformance suites.
describeSessionStore('MemorySessionStore', () => new MemorySessionStore())
describeRateLimitStore('MemoryRateLimitStore', () => new MemoryRateLimitStore())
describeNonceStore('MemoryNonceStore', () => new MemoryNonceStore())

// STORES-ATOMICITY-04: dev-only stores must self-bound (lazy prune expired
// entries) rather than grow the backing Map unboundedly. Pruning is gated on a
// size threshold, so these tests push past it and assert the Map shrinks.
describe('MemoryNonceStore lazy pruning (stores-atomicity-4)', () => {
  afterEach(() => vi.useRealTimers())

  it('sweeps expired nonces once past the size threshold', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const store = new MemoryNonceStore()
    // Internal Map is private; reach it for a size assertion (dev-only store).
    const seen = (store as unknown as { seen: Map<string, number> }).seen
    const THRESHOLD = (MemoryNonceStore as unknown as { PRUNE_THRESHOLD: number })
      .PRUNE_THRESHOLD

    // Fill just past the threshold with short-TTL nonces.
    for (let i = 0; i <= THRESHOLD; i++) {
      await store.checkAndStore(`nonce-${i}`, 1) // 1s TTL
    }
    expect(seen.size).toBe(THRESHOLD + 1)

    // Advance past TTL so every recorded nonce is now expired.
    vi.setSystemTime(2_000)

    // One more write trips the gated sweep, evicting all expired entries.
    await store.checkAndStore('fresh', 60)
    expect(seen.size).toBe(1)
    expect(seen.has('fresh')).toBe(true)
  })

  it('drops an expired hot entry before re-recording it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const store = new MemoryNonceStore()
    const seen = (store as unknown as { seen: Map<string, number> }).seen

    expect(await store.checkAndStore('n', 1)).toBe(true)
    const firstExpiry = seen.get('n')
    vi.setSystemTime(2_000) // past TTL
    // Re-recording an expired nonce is allowed (not a replay) and refreshes it.
    expect(await store.checkAndStore('n', 60)).toBe(true)
    expect(seen.size).toBe(1)
    expect(seen.get('n')).not.toBe(firstExpiry)
  })
})

describe('MemoryRateLimitStore lazy pruning (stores-atomicity-4)', () => {
  afterEach(() => vi.useRealTimers())

  it('evicts fully-refilled idle buckets once past the size threshold', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const store = new MemoryRateLimitStore()
    const buckets = (store as unknown as { buckets: Map<string, unknown> }).buckets
    const THRESHOLD = (MemoryRateLimitStore as unknown as { PRUNE_THRESHOLD: number })
      .PRUNE_THRESHOLD
    const limit = { capacity: 10, refillPerSecond: 10 }

    // Spend a token on many distinct keys so each bucket sits below capacity.
    for (let i = 0; i <= THRESHOLD; i++) {
      await store.consume(`key-${i}`, 1, limit)
    }
    expect(buckets.size).toBe(THRESHOLD + 1)

    // Advance long enough for every bucket to refill back to capacity (idle).
    vi.setSystemTime(5_000)

    // A consume on a new key trips the gated sweep; idle buckets are dropped.
    await store.consume('active', 1, limit)
    // Only the just-touched bucket remains (everything else refilled to full).
    expect(buckets.size).toBe(1)
    expect(buckets.has('active')).toBe(true)
  })

  it('does not evict a bucket that is still below capacity', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const store = new MemoryRateLimitStore()
    const buckets = (store as unknown as { buckets: Map<string, unknown> }).buckets
    const THRESHOLD = (MemoryRateLimitStore as unknown as { PRUNE_THRESHOLD: number })
      .PRUNE_THRESHOLD
    // No refill ever (refillPerSecond 0): drained buckets can never become idle.
    const limit = { capacity: 10, refillPerSecond: 0 }

    for (let i = 0; i <= THRESHOLD; i++) {
      await store.consume(`key-${i}`, 5, limit)
    }
    vi.setSystemTime(1_000_000)
    await store.consume('active', 5, limit)
    // Nothing refilled to capacity, so nothing is pruned.
    expect(buckets.size).toBe(THRESHOLD + 2)
  })
})

// SecretProvider isn't a strong-consistency concern, so it has no shared suite;
// cover the dev impl directly.
describe('MemorySecretProvider', () => {
  async function hmacKey(): Promise<CryptoKey> {
    return crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, true, [
      'sign',
      'verify',
    ])
  }

  it('returns null for an unknown key id', async () => {
    const sp = new MemorySecretProvider()
    expect(await sp.getSigningKey('nope')).toBeNull()
  })

  it('resolves a registered signing key', async () => {
    const sp = new MemorySecretProvider()
    const key = await hmacKey()
    sp.addKey('k1', key)
    expect(await sp.getSigningKey('k1')).toBe(key)
  })

  it('tracks the current key id per client (SIGN-05 rotation)', async () => {
    const sp = new MemorySecretProvider()
    sp.addKey('k-old', await hmacKey(), { clientId: 'svc-a' })
    sp.addKey('k-new', await hmacKey(), { clientId: 'svc-a', current: true })
    expect(await sp.getCurrentKeyId('svc-a')).toBe('k-new')
    // Both keys still resolvable during the overlap window.
    expect(await sp.getSigningKey('k-old')).not.toBeNull()
    expect(await sp.getSigningKey('k-new')).not.toBeNull()
  })

  it('throws when no current key is registered for a client', async () => {
    const sp = new MemorySecretProvider()
    await expect(sp.getCurrentKeyId('unknown')).rejects.toThrow()
  })
})
