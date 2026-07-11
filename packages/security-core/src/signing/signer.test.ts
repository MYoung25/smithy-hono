import { describe, it, expect } from 'vitest'
import { signRequest, importHmacKey } from './signer.js'
import { parseAuthorizationHeader } from './canonical.js'

const SECRET = 'test-secret-0123456789'

describe('signer — importHmacKey', () => {
  it('imports a raw string secret as an HMAC sign key', async () => {
    const key = await importHmacKey(SECRET, ['sign'])
    expect(key.type).toBe('secret')
    expect(key.algorithm.name).toBe('HMAC')
    expect(key.usages).toContain('sign')
  })

  it('imports with both sign and verify usages', async () => {
    const key = await importHmacKey(SECRET, ['sign', 'verify'])
    expect(key.usages).toEqual(expect.arrayContaining(['sign', 'verify']))
  })
})

describe('signer — signRequest', () => {
  it('produces a deterministic Authorization for fixed inputs', async () => {
    const key = await importHmacKey(SECRET, ['sign'])
    const signed = await signRequest({
      method: 'POST',
      url: 'https://api.example.com/todos?b=2&a=1',
      headers: { Host: 'api.example.com', 'X-SH-Timestamp': '1700000000' },
      body: '{"title":"buy milk"}',
      keyId: 'key-1',
      key,
      signedHeaders: ['host', 'x-sh-timestamp'],
      timestamp: 1700000000,
    })
    expect(signed.authorization).toBe(
      'SH-HMAC-SHA256 keyId=key-1, signedHeaders=host;x-sh-timestamp, signature=' +
        'd4a13716472ca41ab979d167ada42b9641f9b393c4c2ed525b1f41cbb91ae18e',
    )
  })

  it('attaches X-SH-Timestamp and the re-derived X-SH-Body-Sha256 headers', async () => {
    const key = await importHmacKey(SECRET, ['sign'])
    const signed = await signRequest({
      method: 'POST',
      url: 'https://api.example.com/todos',
      headers: { Host: 'api.example.com' },
      body: '{"title":"buy milk"}',
      keyId: 'key-1',
      key,
      signedHeaders: ['host'],
      timestamp: 1700000000,
    })
    expect(signed.headers['X-SH-Timestamp']).toBe('1700000000')
    expect(signed.headers['X-SH-Body-Sha256']).toBe(
      'ee7451d2de804f7acd781fac819cb957bee046de915359dd694cbad325b09f8e',
    )
    expect(signed.headers['Authorization']).toBe(signed.authorization)
  })

  it('signs an empty body with the empty SHA-256', async () => {
    const key = await importHmacKey(SECRET, ['sign'])
    const signed = await signRequest({
      method: 'GET',
      url: 'https://api.example.com/todos',
      headers: {},
      keyId: 'key-1',
      key,
      signedHeaders: ['host'],
      timestamp: 1700000000,
    })
    expect(signed.bodySha256).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('produces an Authorization that parses back to its parts', async () => {
    const key = await importHmacKey(SECRET, ['sign'])
    const signed = await signRequest({
      method: 'POST',
      url: 'https://api.example.com/todos',
      headers: { Host: 'api.example.com', 'X-SH-Timestamp': '1700000000' },
      body: 'x',
      keyId: 'key-7',
      key,
      signedHeaders: ['host', 'x-sh-timestamp'],
      timestamp: 1700000000,
    })
    const parsed = parseAuthorizationHeader(signed.authorization)
    expect(parsed).toMatchObject({
      keyId: 'key-7',
      signedHeaders: ['host', 'x-sh-timestamp'],
    })
  })
})
