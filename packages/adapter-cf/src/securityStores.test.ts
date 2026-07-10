import { describe, it, expect, vi, beforeEach } from 'vitest'

// Control `createOidcVerifier` so we can drive the discovery-failure path without
// a live network. `vi.hoisted` lets the mock reference a mutable impl per test.
const h = vi.hoisted(() => ({
  impl: vi.fn(),
}))

vi.mock('@smithy-hono/security-core', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>()
  return { ...actual, createOidcVerifier: (...args: unknown[]) => h.impl(...args) }
})

import { lazyOidcVerifier } from './securityStores.js'

describe('lazyOidcVerifier', () => {
  beforeEach(() => {
    h.impl.mockReset()
  })

  it('does NOT cache a rejected discovery promise (retries on next call)', async () => {
    const boom = new Error('discovery fetch failed')
    // First call rejects (transient outage), second call succeeds.
    const verifier = { verify: () => {} }
    h.impl.mockRejectedValueOnce(boom).mockResolvedValueOnce(verifier)

    const get = lazyOidcVerifier({ issuer: 'https://issuer.example' } as never)

    await expect(get()).rejects.toBe(boom)
    // The failure must not be pinned: the next call retries and succeeds.
    await expect(get()).resolves.toBe(verifier)
    expect(h.impl).toHaveBeenCalledTimes(2)
  })

  it('caches the SUCCESS (builds the verifier exactly once)', async () => {
    const verifier = { verify: () => {} }
    h.impl.mockResolvedValue(verifier)

    const get = lazyOidcVerifier({ issuer: 'https://issuer.example' } as never)
    const a = await get()
    const b = await get()
    expect(a).toBe(verifier)
    expect(b).toBe(verifier)
    expect(h.impl).toHaveBeenCalledTimes(1)
  })
})
