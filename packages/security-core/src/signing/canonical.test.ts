import { describe, it, expect } from 'vitest'
import {
  SH_HMAC_SHA256,
  buildCanonicalString,
  canonicalHeaders,
  canonicalQuery,
  encodeRfc3986,
  fromHex,
  toHex,
  sha256Hex,
  parseAuthorizationHeader,
  formatAuthorizationHeader,
} from './canonical.js'

describe('canonical — hex helpers', () => {
  it('toHex / fromHex round-trip', () => {
    const bytes = new Uint8Array([0x00, 0x0f, 0xa0, 0xff, 0x10])
    expect(toHex(bytes)).toBe('000fa0ff10')
    expect(fromHex('000fa0ff10')).toEqual(bytes)
  })

  it('fromHex returns null on malformed input', () => {
    expect(fromHex('abc')).toBeNull() // odd length
    expect(fromHex('zz')).toBeNull() // non-hex
    expect(fromHex('00gg')).toBeNull()
  })
})

describe('canonical — sha256Hex (published vectors)', () => {
  it('hashes the empty input to the well-known empty SHA-256', async () => {
    expect(await sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('hashes "hello" to its published vector', async () => {
    expect(await sha256Hex(new TextEncoder().encode('hello'))).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    )
  })

  it('accepts an ArrayBuffer and a Uint8Array identically', async () => {
    const u8 = new TextEncoder().encode('hello')
    const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)
    expect(await sha256Hex(ab)).toBe(await sha256Hex(u8))
  })
})

describe('canonical — RFC3986 query encoding', () => {
  it('encodes the chars encodeURIComponent leaves alone', () => {
    expect(encodeRfc3986("a!'()*")).toBe('a%21%27%28%29%2A')
  })

  it('passes ~ through (unreserved) but encodes space as %20', () => {
    expect(encodeRfc3986('a~b c')).toBe('a~b%20c')
  })

  it('sorts params by key then value and re-encodes canonically', () => {
    expect(canonicalQuery('z=9&a=hello%20world&a=alpha')).toBe(
      'a=alpha&a=hello%20world&z=9',
    )
  })

  it('treats a valueless param as key=', () => {
    expect(canonicalQuery('flag&b=2')).toBe('b=2&flag=')
  })

  it('empty query → empty string', () => {
    expect(canonicalQuery('')).toBe('')
  })

  it('collapses + and %20 to the same canonical %20', () => {
    expect(canonicalQuery('q=a+b')).toBe('q=a%20b')
    expect(canonicalQuery('q=a%20b')).toBe('q=a%20b')
  })
})

describe('canonical — header canonicalization', () => {
  it('lowercases names, trims/collapses values, sorts by name', () => {
    expect(
      canonicalHeaders([
        ['X-Foo', '  bar  baz '],
        ['Host', 'api.example.com'],
      ]),
    ).toBe('host:api.example.com\nx-foo:bar baz\n')
  })

  it('a listed-but-empty header yields name:', () => {
    expect(canonicalHeaders([['x-empty', '']])).toBe('x-empty:\n')
  })
})

describe('canonical — buildCanonicalString (byte-exact fixture)', () => {
  it('produces the exact six-field string for a known input', () => {
    const canonical = buildCanonicalString({
      method: 'post',
      path: '/todos',
      query: 'b=2&a=1',
      signedHeaders: [
        ['X-SH-Timestamp', '1700000000'],
        ['Host', 'api.example.com'],
      ],
      bodySha256Hex:
        'ee7451d2de804f7acd781fac819cb957bee046de915359dd694cbad325b09f8e',
      timestamp: 1700000000,
    })
    expect(canonical).toBe(
      'POST\n' +
        '/todos\n' +
        'a=1&b=2\n' +
        'host:api.example.com\n' +
        'x-sh-timestamp:1700000000\n' +
        '\n' +
        'ee7451d2de804f7acd781fac819cb957bee046de915359dd694cbad325b09f8e\n' +
        '1700000000\n',
    )
  })

  it('uppercases the method and normalizes an empty path to /', () => {
    const canonical = buildCanonicalString({
      method: 'get',
      path: '',
      query: '',
      signedHeaders: [],
      bodySha256Hex: 'x',
      timestamp: 1,
    })
    expect(canonical).toBe('GET\n/\n\n\nx\n1\n')
  })
})

describe('canonical — parseAuthorizationHeader', () => {
  const valid =
    'SH-HMAC-SHA256 keyId=key-1, signedHeaders=host;x-sh-timestamp, signature=deadbeef'

  it('parses a well-formed value', () => {
    expect(parseAuthorizationHeader(valid)).toEqual({
      keyId: 'key-1',
      signedHeaders: ['host', 'x-sh-timestamp'],
      signature: 'deadbeef',
    })
  })

  it('lowercases the signedHeaders list', () => {
    const v =
      'SH-HMAC-SHA256 keyId=k, signedHeaders=Host;X-SH-Timestamp, signature=ab'
    expect(parseAuthorizationHeader(v)?.signedHeaders).toEqual([
      'host',
      'x-sh-timestamp',
    ])
  })

  it('lowercases the signature so the nonce-replay key is canonical (finding signing-1)', () => {
    // A case-flipped hex signature decodes to identical bytes and verifies, so if
    // the raw value were kept it would be a distinct nonce-replay key. Normalizing
    // at parse time makes fromHex, verify, and the nonce key share one form.
    const upper =
      'SH-HMAC-SHA256 keyId=k, signedHeaders=host, signature=DEADBEEF'
    expect(parseAuthorizationHeader(upper)?.signature).toBe('deadbeef')
  })

  it('rejects a duplicate signed-header name (finding signing-5)', () => {
    const dup =
      'SH-HMAC-SHA256 keyId=k, signedHeaders=host;host, signature=ab'
    expect(parseAuthorizationHeader(dup)).toBeNull()
  })

  it.each([
    ['undefined', undefined],
    ['wrong scheme', 'AWS4-HMAC-SHA256 keyId=k, signedHeaders=h, signature=ab'],
    ['no params', 'SH-HMAC-SHA256 '],
    ['missing keyId', 'SH-HMAC-SHA256 signedHeaders=host, signature=ab'],
    ['missing signedHeaders', 'SH-HMAC-SHA256 keyId=k, signature=ab'],
    ['missing signature', 'SH-HMAC-SHA256 keyId=k, signedHeaders=host'],
    ['empty value', 'SH-HMAC-SHA256 keyId=, signedHeaders=host, signature=ab'],
    ['param without =', 'SH-HMAC-SHA256 keyId=k, signedHeaders, signature=ab'],
    // SIGNING-06 — strict parsing: reject duplicates and extras.
    [
      'duplicate keyId',
      'SH-HMAC-SHA256 keyId=a, keyId=b, signedHeaders=host, signature=ab',
    ],
    [
      'unexpected extra param',
      'SH-HMAC-SHA256 keyId=k, signedHeaders=host, signature=ab, foo=bar',
    ],
  ])('returns null on %s', (_label, input) => {
    expect(parseAuthorizationHeader(input as string | undefined)).toBeNull()
  })

  it('round-trips through formatAuthorizationHeader', () => {
    const parsed = parseAuthorizationHeader(valid)!
    expect(parseAuthorizationHeader(formatAuthorizationHeader(parsed))).toEqual(
      parsed,
    )
  })

  it('exposes the scheme constant', () => {
    expect(SH_HMAC_SHA256).toBe('SH-HMAC-SHA256')
  })
})
