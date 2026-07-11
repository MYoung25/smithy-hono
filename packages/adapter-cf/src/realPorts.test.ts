/**
 * Tests the production fetch() wiring end to end against the real
 * SecurityDurableObject over an in-process Map storage: the store →
 * fetch-stub → DO HTTP contract → DO logic → storage round-trip. Proves the
 * {@link DO_PATHS} request/response shape is internally consistent.
 */

import { describe, it, expect } from 'vitest'
import { SecurityDurableObject } from './durableObject.js'
import { InMemoryDurableStorage } from './test-support.js'
import {
  createFetchRateLimitStub,
  createFetchNonceStub,
  type DurableObjectStubLike,
} from './realPorts.js'
import { DurableRateLimitStore } from './rateLimitStore.js'
import { DurableNonceStore } from './nonceStore.js'

/** Wrap a SecurityDurableObject instance as a fetch stub the store can call. */
function stubFor(): DurableObjectStubLike {
  const objectsByPathBucket = new SecurityDurableObject({
    storage: new InMemoryDurableStorage(),
  })
  return { fetch: (req) => objectsByPathBucket.fetch(req) }
}

describe('fetch-based DO stubs over SecurityDurableObject', () => {
  it('rate-limit store consumes through the fetch contract', async () => {
    const store = new DurableRateLimitStore(createFetchRateLimitStub(stubFor()))
    const spec = { capacity: 3, refillPerSecond: 1 }
    expect((await store.consume('k', 1, spec)).remaining).toBe(2)
    expect((await store.consume('k', 1, spec)).remaining).toBe(1)
    expect((await store.consume('k', 1, spec)).remaining).toBe(0)
    const denied = await store.consume('k', 1, spec)
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('round-trips a never-refill bucket without collapsing Infinity to a 0s back-off', async () => {
    // refillPerSecond <= 0 => resetAt/retryAfterSeconds are Infinity. JSON would
    // serialize those to null (=> Retry-After 0); the -1 sentinel must survive.
    const store = new DurableRateLimitStore(createFetchRateLimitStub(stubFor()))
    const spec = { capacity: 1, refillPerSecond: 0 }
    expect((await store.consume('never', 1, spec)).allowed).toBe(true)
    const denied = await store.consume('never', 1, spec)
    expect(denied.allowed).toBe(false)
    expect(denied.resetAt).toBe(Infinity)
    expect(denied.retryAfterSeconds).toBe(Infinity)
  })

  it('nonce store checks through the fetch contract (accept once, then replay)', async () => {
    const store = new DurableNonceStore(createFetchNonceStub(stubFor()))
    expect(await store.checkAndStore('n1', 60)).toBe(true)
    expect(await store.checkAndStore('n1', 60)).toBe(false)
    expect(await store.checkAndStore('n2', 60)).toBe(true)
  })

  it('returns 404 for an unknown DO path', async () => {
    const obj = new SecurityDurableObject({ storage: new InMemoryDurableStorage() })
    const res = await obj.fetch(new Request('https://do.internal/nope', { method: 'POST' }))
    expect(res.status).toBe(404)
  })
})
