import { describe, it, expect, vi, afterEach } from 'vitest'
import { SecretsManagerSecretProvider } from './secrets.js'
import { FakeSecretsSource } from './test-support.js'

afterEach(() => {
  vi.restoreAllMocks()
})

/** base64-encode raw bytes (test helper; the provider expects base64 material). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

describe('SecretsManagerSecretProvider', () => {
  const rawKey = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
  const b64 = bytesToBase64(rawKey)

  function provider() {
    const source = new FakeSecretsSource({ 'secret/k1': b64 })
    return new SecretsManagerSecretProvider(source, {
      keyIdToSecretId: { k1: 'secret/k1' },
      clientToCurrentKeyId: { clientA: 'k1' },
    })
  }

  it('imports an HMAC verify-only CryptoKey from base64 material', async () => {
    const key = await provider().getSigningKey('k1')
    expect(key).not.toBeNull()
    expect(key!.type).toBe('secret')
    expect(key!.algorithm).toMatchObject({ name: 'HMAC' })
    expect(key!.usages).toEqual(['verify'])
    expect(key!.extractable).toBe(false)
  })

  it('the imported key actually verifies an HMAC signature', async () => {
    const key = await provider().getSigningKey('k1')
    const data = new TextEncoder().encode('payload')
    // Sign with an extractable twin of the same raw key, verify with the provider key.
    const signKey = await crypto.subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const sig = await crypto.subtle.sign('HMAC', signKey, data)
    expect(await crypto.subtle.verify('HMAC', key!, sig, data)).toBe(true)
  })

  it('returns null for an unknown/retired keyId', async () => {
    expect(await provider().getSigningKey('nope')).toBeNull()
  })

  it('returns null when the secret is missing in the source', async () => {
    const source = new FakeSecretsSource({}) // no material
    const p = new SecretsManagerSecretProvider(source, {
      keyIdToSecretId: { k1: 'secret/k1' },
      clientToCurrentKeyId: {},
    })
    expect(await p.getSigningKey('k1')).toBeNull()
  })

  it('caches the imported key (one fetch per keyId)', async () => {
    let fetches = 0
    const source = {
      async getSecretString(id: string) {
        fetches++
        return id === 'secret/k1' ? b64 : null
      },
    }
    const p = new SecretsManagerSecretProvider(source, {
      keyIdToSecretId: { k1: 'secret/k1' },
      clientToCurrentKeyId: {},
    })
    await p.getSigningKey('k1')
    await p.getSigningKey('k1')
    expect(fetches).toBe(1)
  })

  it('re-consults Secrets Manager once the cache TTL lapses and fails closed on revocation (SIGN-05)', async () => {
    let present = true
    let fetches = 0
    const source = {
      async getSecretString(id: string) {
        fetches++
        return present && id === 'secret/k1' ? b64 : null
      },
    }
    const p = new SecretsManagerSecretProvider(source, {
      keyIdToSecretId: { k1: 'secret/k1' },
      clientToCurrentKeyId: {},
      cacheTtlMs: 1000,
    })
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(0)
    expect(await p.getSigningKey('k1')).not.toBeNull()
    expect(fetches).toBe(1)

    // Within TTL: cache hit, no extra fetch.
    now.mockReturnValue(500)
    expect(await p.getSigningKey('k1')).not.toBeNull()
    expect(fetches).toBe(1)

    // Revoke at the source, advance past TTL: re-fetch, evict, fail closed.
    present = false
    now.mockReturnValue(2000)
    expect(await p.getSigningKey('k1')).toBeNull()
    expect(fetches).toBe(2)
  })

  it('does NOT cache a rejected import (transient error retries, no TTL-long outage)', async () => {
    let calls = 0
    const source = {
      async getSecretString(id: string) {
        calls++
        // First call throws (throttle/network); second call succeeds.
        if (calls === 1) throw new Error('throttled')
        return id === 'secret/k1' ? b64 : null
      },
    }
    const p = new SecretsManagerSecretProvider(source, {
      keyIdToSecretId: { k1: 'secret/k1' },
      clientToCurrentKeyId: {},
      cacheTtlMs: 300_000,
    })
    // The rejection must propagate but NOT be cached.
    await expect(p.getSigningKey('k1')).rejects.toThrow(/throttled/)
    // Immediately (well within TTL) a retry re-fetches and succeeds — no pinned
    // rejection re-thrown for the whole window.
    expect(await p.getSigningKey('k1')).not.toBeNull()
    expect(calls).toBe(2)
  })

  it('resolves the current keyId per client (SIGN-05)', async () => {
    expect(await provider().getCurrentKeyId('clientA')).toBe('k1')
  })

  it('throws for a client with no configured current key', async () => {
    await expect(provider().getCurrentKeyId('ghost')).rejects.toThrow(/no current signing key/i)
  })
})
