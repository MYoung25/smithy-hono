/**
 * Unit tests for the env-backed SecretProvider: hex import, non-extractability,
 * verify-only usage (SIGN-05/06), and current-key resolution.
 */

import { describe, it, expect } from 'vitest'
import { EnvSecretProvider, CfKeyBackend, type KvDirectoryLike } from './secrets.js'

// 32-byte hex secret (HMAC-SHA-256 key material).
const HEX_KEY =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'

describe('EnvSecretProvider', () => {
  it('imports a hex key as a verify-only, non-extractable HMAC CryptoKey', async () => {
    const provider = new EnvSecretProvider(
      { 'key-1': HEX_KEY },
      { 'client-a': 'key-1' },
    )
    const key = await provider.getSigningKey('key-1')
    expect(key).not.toBeNull()
    expect(key!.type).toBe('secret')
    expect(key!.extractable).toBe(false)
    expect(key!.usages).toEqual(['verify'])
    expect((key!.algorithm as { name: string }).name).toBe('HMAC')
  })

  it('verifies a signature it can recompute (round-trip sanity)', async () => {
    // Independent sign key with the SAME bytes to produce a known signature.
    const bytes = new Uint8Array(
      HEX_KEY.match(/../g)!.map((h) => parseInt(h, 16)),
    )
    const signKey = await crypto.subtle.importKey(
      'raw',
      bytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const data = new TextEncoder().encode('payload')
    const sig = await crypto.subtle.sign('HMAC', signKey, data)

    const provider = new EnvSecretProvider({ k: HEX_KEY }, {})
    const verifyKey = await provider.getSigningKey('k')
    const ok = await crypto.subtle.verify('HMAC', verifyKey!, sig, data)
    expect(ok).toBe(true)
  })

  it('returns null for an unknown keyId', async () => {
    const provider = new EnvSecretProvider({ k: HEX_KEY }, {})
    expect(await provider.getSigningKey('missing')).toBeNull()
  })

  it('caches the imported key (same instance on repeat)', async () => {
    const provider = new EnvSecretProvider({ k: HEX_KEY }, {})
    const a = await provider.getSigningKey('k')
    const b = await provider.getSigningKey('k')
    expect(a).toBe(b)
  })

  it('resolves the current keyId per client and throws for unknown clients', async () => {
    const provider = new EnvSecretProvider(
      { 'key-1': HEX_KEY },
      { 'client-a': 'key-1' },
    )
    expect(await provider.getCurrentKeyId('client-a')).toBe('key-1')
    await expect(provider.getCurrentKeyId('nope')).rejects.toThrow(/client 'nope'/)
  })

  it('rejects malformed (non-hex / odd-length) material', async () => {
    const provider = new EnvSecretProvider({ bad: 'xyz' }, {})
    await expect(provider.getSigningKey('bad')).rejects.toThrow(/hex/)
  })
})

describe('CfKeyBackend.getDirectoryEntry corruption guard (SECRETS-DATA-SQL-05)', () => {
  function backendWith(raw: string | null): CfKeyBackend {
    const kv: KvDirectoryLike = {
      async get() {
        return raw
      },
      async put() {},
    }
    return new CfKeyBackend({}, kv)
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
