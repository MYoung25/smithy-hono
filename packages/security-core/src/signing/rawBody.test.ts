/**
 * ARCH-08 raw-body spike — the gate proof for Phase S6 (HMAC signing, SIGN-07).
 *
 * Proves on Node/vitest that `readRawBody(c)` reads the exact request bytes the
 * verifier would hash, AND that a subsequent `c.req.json()` on the SAME request
 * still parses correctly — i.e. the body is not consumed twice or lost. This is
 * the mechanism Phase S6's `verifySignature` depends on.
 */

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { readRawBody } from './rawBody.js'

/** Hex-encode an ArrayBuffer digest, mirroring the `toHex` the S6 verifier uses. */
function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function sha256Hex(data: ArrayBuffer | string): Promise<string> {
  // Normalize to an ArrayBuffer so the BufferSource type stays concrete.
  const bytes: ArrayBuffer =
    typeof data === 'string'
      ? (() => {
          const u8 = new TextEncoder().encode(data)
          return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
        })()
      : data
  return toHex(await crypto.subtle.digest('SHA-256', bytes))
}

describe('readRawBody — ARCH-08 / SIGN-07 core proof', () => {
  it('reads raw bytes AND lets a subsequent c.req.json() parse the same body', async () => {
    const payload = { hello: 'world', n: 42, nested: { a: [1, 2, 3] } }
    const bodyText = JSON.stringify(payload)
    // Independent oracle: SHA-256 of the exact bytes the "client" sent.
    const expectedDigest = await sha256Hex(bodyText)

    const seen: { digest?: string; parsed?: unknown } = {}

    const app = new Hono()
    app.post('/sign', async (c: Context) => {
      // (1) verifier path: raw bytes → digest
      const raw = await readRawBody(c)
      seen.digest = toHex(await crypto.subtle.digest('SHA-256', raw))
      // (2) deserializer path: the SAME request still parses
      seen.parsed = await c.req.json()
      return c.json({ ok: true })
    })

    const res = await app.request('/sign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bodyText,
    })

    // Both paths succeeded:
    expect(res.status).toBe(200)
    // JSON deserialized correctly after the raw read (not consumed twice / lost):
    expect(seen.parsed).toEqual(payload)
    // Verifier hashed the exact client bytes (byte-exact, independently derived):
    expect(seen.digest).toBe(expectedDigest)
  })

  it('order-independent: json() first, then readRawBody still hashes the same bytes', async () => {
    const bodyText = JSON.stringify({ a: 1 })
    const expectedDigest = await sha256Hex(bodyText)
    let digest = ''
    let parsed: unknown

    const app = new Hono()
    app.post('/x', async (c) => {
      parsed = await c.req.json() // deserializer reads first this time
      const raw = await readRawBody(c) // verifier still gets the same bytes
      digest = await sha256Hex(raw)
      return c.json({ ok: true })
    })

    const res = await app.request('/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bodyText,
    })
    expect(res.status).toBe(200)
    expect(parsed).toEqual({ a: 1 })
    expect(digest).toBe(expectedDigest)
  })
})

describe('readRawBody — byte-exact digest (test oracle parity)', () => {
  it('matches a hardcoded, independently-computed SHA-256 for a known payload', async () => {
    // SHA-256("hello") — the canonical, widely-published vector. Proves the
    // verifier would hash exactly the bytes the client signed.
    const KNOWN = 'hello'
    const KNOWN_SHA256 =
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'

    const app = new Hono()
    let digest = ''
    app.post('/k', async (c) => {
      const raw = await readRawBody(c)
      digest = await sha256Hex(raw)
      return c.json({ ok: true })
    })

    await app.request('/k', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: KNOWN,
    })
    expect(digest).toBe(KNOWN_SHA256)
  })

  it('preserves bytes exactly for a non-ASCII / multibyte payload', async () => {
    const bodyText = JSON.stringify({ msg: 'héllo — 世界 🌍' })
    const expected = await sha256Hex(bodyText)

    const app = new Hono()
    let digest = ''
    let parsed: unknown
    app.post('/u', async (c) => {
      const raw = await readRawBody(c)
      digest = await sha256Hex(raw)
      parsed = await c.req.json()
      return c.json({ ok: true })
    })

    await app.request('/u', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bodyText,
    })
    expect(digest).toBe(expected)
    expect(parsed).toEqual({ msg: 'héllo — 世界 🌍' })
  })
})

describe('readRawBody — empty / bodyless requests', () => {
  it('returns an empty buffer for a GET with no body (no throw)', async () => {
    const app = new Hono()
    let len = -1
    let digest = ''
    app.get('/g', async (c) => {
      const raw = await readRawBody(c)
      len = raw.byteLength
      digest = await sha256Hex(raw)
      return c.json({ ok: true })
    })

    const res = await app.request('/g', { method: 'GET' })
    expect(res.status).toBe(200)
    expect(len).toBe(0)
    // SHA-256 of the empty input is well-defined — verifier never throws on no body.
    expect(digest).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('returns an empty buffer for a POST with an empty body', async () => {
    const app = new Hono()
    let len = -1
    app.post('/e', async (c) => {
      const raw = await readRawBody(c)
      len = raw.byteLength
      return c.json({ ok: true })
    })

    const res = await app.request('/e', { method: 'POST', body: '' })
    expect(res.status).toBe(200)
    expect(len).toBe(0)
  })
})

describe('readRawBody — idempotent (cache makes repeat reads safe)', () => {
  it('two readRawBody calls return identical bytes and json() still parses', async () => {
    const bodyText = JSON.stringify({ dup: true, items: [1, 2] })
    const expected = await sha256Hex(bodyText)

    const app = new Hono()
    let d1 = ''
    let d2 = ''
    let parsed: unknown
    app.post('/d', async (c) => {
      d1 = await sha256Hex(await readRawBody(c))
      d2 = await sha256Hex(await readRawBody(c)) // second read — served from cache
      parsed = await c.req.json() // still works after two raw reads
      return c.json({ ok: true })
    })

    const res = await app.request('/d', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bodyText,
    })
    expect(res.status).toBe(200)
    expect(d1).toBe(expected)
    expect(d2).toBe(expected)
    expect(parsed).toEqual({ dup: true, items: [1, 2] })
  })
})
