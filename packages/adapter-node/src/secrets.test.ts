/**
 * Unit tests for the Node SecretProvider: base64 HMAC import → verifiable
 * CryptoKey, current-key resolution + rotation, env-backed source isolation.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  NodeSecretProvider,
  RedisKeyBackend,
  recordSecretSource,
  type SecretSourceLike,
} from './secrets.js'
import { createFakeRedisPort } from './ports.js'
import { envSecretSource } from './secretsEnv.js'

const bytesToBase64 = (bytes: Uint8Array): string => {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

const RAW = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
const RAW_B64 = bytesToBase64(RAW)

describe('NodeSecretProvider', () => {
  it('imports base64 HMAC material as a verify-usage CryptoKey', async () => {
    const provider = new NodeSecretProvider(recordSecretSource({ k1: RAW_B64 }), {
      currentKeyByClient: { 'client-a': 'k1' },
    })
    const key = await provider.getSigningKey('k1')
    expect(key).not.toBeNull()
    expect(key!.type).toBe('secret')
    expect(key!.usages).toContain('verify')
    expect((key!.algorithm as { name: string }).name).toBe('HMAC')

    // The imported key actually verifies an HMAC produced from the same raw bytes.
    const signKey = await crypto.subtle.importKey(
      'raw',
      RAW,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const data = new TextEncoder().encode('payload')
    const sig = await crypto.subtle.sign('HMAC', signKey, data)
    expect(await crypto.subtle.verify('HMAC', key!, sig, data)).toBe(true)
  })

  it('returns null for an unknown / retired key', async () => {
    const provider = new NodeSecretProvider(recordSecretSource({}), {
      currentKeyByClient: {},
    })
    expect(await provider.getSigningKey('nope')).toBeNull()
  })

  it('resolves the current key id per client and supports rotation', async () => {
    // Source still holds the previous key (k1) within the rotation window (SIGN-05).
    const provider = new NodeSecretProvider(
      recordSecretSource({ k1: RAW_B64, k2: RAW_B64 }),
      { currentKeyByClient: { 'client-a': 'k2' } },
    )
    expect(await provider.getCurrentKeyId('client-a')).toBe('k2')
    expect(await provider.getSigningKey('k1')).not.toBeNull() // previous still verifies
    expect(await provider.getSigningKey('k2')).not.toBeNull()
  })

  it('throws for a client with no current key registered', async () => {
    const provider = new NodeSecretProvider(recordSecretSource({}), {
      currentKeyByClient: {},
    })
    await expect(provider.getCurrentKeyId('ghost')).rejects.toThrow(/ghost/)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('NodeSecretProvider revocation-aware cache (SIGN-05)', () => {
  /** A source whose material can be revoked (deleted) mid-test, counting reads. */
  function revocableSource(initial: Record<string, string>): {
    source: SecretSourceLike
    reads: () => number
    revoke: (keyId: string) => void
  } {
    const store = new Map(Object.entries(initial))
    let reads = 0
    return {
      source: {
        async get(keyId) {
          reads++
          return store.get(keyId) ?? null
        },
      },
      reads: () => reads,
      revoke: (keyId) => store.delete(keyId),
    }
  }

  it('keeps verifying within the TTL but re-consults the source once stale', async () => {
    const { source, reads, revoke } = revocableSource({ k1: RAW_B64 })
    const provider = new NodeSecretProvider(source, {
      currentKeyByClient: {},
      cacheTtlMs: 1000,
    })
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(0)
    expect(await provider.getSigningKey('k1')).not.toBeNull()
    expect(reads()).toBe(1)

    // Within TTL: cache hit, no extra source read.
    now.mockReturnValue(500)
    expect(await provider.getSigningKey('k1')).not.toBeNull()
    expect(reads()).toBe(1)

    // Revoke at the source, then advance past the TTL: re-read, evict, fail closed.
    revoke('k1')
    now.mockReturnValue(2000)
    expect(await provider.getSigningKey('k1')).toBeNull()
    expect(reads()).toBe(2)
  })

  it('cacheTtlMs=0 re-consults the source on every call', async () => {
    const { source, reads } = revocableSource({ k1: RAW_B64 })
    const provider = new NodeSecretProvider(source, {
      currentKeyByClient: {},
      cacheTtlMs: 0,
    })
    await provider.getSigningKey('k1')
    await provider.getSigningKey('k1')
    expect(reads()).toBe(2)
  })
})

describe('RedisKeyBackend.getDirectoryEntry corruption guard (SECRETS-DATA-SQL-05)', () => {
  function backendWith(raw: string | null): RedisKeyBackend {
    const port = {
      async get() {
        return raw
      },
      async set() {
        return true
      },
      async del() {},
      async pexpire() {},
      async evalTokenBucket() {
        throw new Error('unused')
      },
    }
    return new RedisKeyBackend(port as never)
  }

  it('returns null when the entry is absent', async () => {
    expect(await backendWith(null).getDirectoryEntry('c')).toBeNull()
  })

  it('throws a descriptive error on non-JSON', async () => {
    await expect(backendWith('not json').getDirectoryEntry('c')).rejects.toThrow(
      /Corrupt directory entry for client 'c'/,
    )
  })

  it('throws on a valid-but-shapeless entry (missing string current)', async () => {
    await expect(backendWith('{}').getDirectoryEntry('c')).rejects.toThrow(
      /missing string 'current'/,
    )
  })

  it('parses a well-formed entry', async () => {
    const entry = await backendWith('{"current":"k2","previous":"k1"}').getDirectoryEntry('c')
    expect(entry).toEqual({ current: 'k2', previous: 'k1' })
  })
})

describe('RedisKeyBackend.putDirectoryEntryIfAbsent (NX provision atomicity, KEY-TOOL-05)', () => {
  it('writes when absent (true) and refuses to overwrite when present (false)', async () => {
    const backend = new RedisKeyBackend(createFakeRedisPort())
    // First create wins.
    expect(await backend.putDirectoryEntryIfAbsent('c', { current: 'c.k1' })).toBe(true)
    expect(await backend.getDirectoryEntry('c')).toEqual({ current: 'c.k1' })
    // A second NX create is skipped — returns false and leaves the entry untouched.
    expect(await backend.putDirectoryEntryIfAbsent('c', { current: 'c.k2' })).toBe(false)
    expect(await backend.getDirectoryEntry('c')).toEqual({ current: 'c.k1' })
  })
})

describe('envSecretSource', () => {
  it('reads base64 material from an injected env map with normalized names', async () => {
    const source = envSecretSource({
      env: { SIGNING_KEY_CLIENT_A_V2: RAW_B64 },
    })
    expect(await source.get('client-a.v2')).toBe(RAW_B64)
    expect(await source.get('missing')).toBeNull()
  })

  it('fails closed on a key-confusion collision (two keyIds → same env name)', async () => {
    const source = envSecretSource({ env: { SIGNING_KEY_CLIENT_A_V2: RAW_B64 } })
    // First keyId claims the normalized name.
    expect(await source.get('client-a.v2')).toBe(RAW_B64)
    // A DISTINCT keyId normalizing to the same name must throw, not share material.
    await expect(source.get('client.a.v2')).rejects.toThrow(/collision/)
    // The original keyId still resolves (idempotent re-read of the same owner).
    expect(await source.get('client-a.v2')).toBe(RAW_B64)
  })

  it('does not record (claim) keyIds that resolve to no env var (bounds guard map, DoS)', async () => {
    // Neither keyId has a backing env var. Both normalize to SIGNING_KEY_FOO_BAR,
    // but since the read misses BEFORE the collision guard, the first miss must not
    // "claim" the name — so a second colliding miss returns null instead of a
    // spurious throw, and the guard map never grows on attacker-supplied keyIds.
    const source = envSecretSource({ env: {} })
    expect(await source.get('foo.bar')).toBeNull()
    expect(await source.get('foo-bar')).toBeNull()
  })

  it('drives a working provider end-to-end', async () => {
    const provider = new NodeSecretProvider(
      envSecretSource({ env: { SIGNING_KEY_K1: RAW_B64 } }),
      { currentKeyByClient: { c: 'k1' } },
    )
    expect(await provider.getSigningKey('k1')).not.toBeNull()
  })
})
