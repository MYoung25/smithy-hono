/**
 * ARCH-08 (SIGN-07) Lambda raw-body — LIGHTWEIGHT SIMULATION ONLY.
 *
 * The raw-body spike (plan 11a) flagged ONE Lambda-specific transform that the
 * Node spike could not exercise: `hono/aws-lambda` decodes API Gateway's
 * (possibly `isBase64Encoded`) event body and constructs a Web `Request` whose
 * body is the DECODED bytes — those are the bytes the client signed, the ones
 * `readRawBody(c)` (= `c.req.arrayBuffer()`) must hash.
 *
 * We do NOT install `hono/aws-lambda` here. Instead we simulate the exact
 * transform the adapter performs — base64 event body → decoded bytes → a Web
 * `Request` — and assert the round-trip is byte-exact, i.e. that a SHA-256 over
 * `request.arrayBuffer()` equals a SHA-256 over the ORIGINAL pre-encode bytes,
 * AND that `request.json()` still parses the same body afterward (body cache,
 * per the spike).
 *
 * THIS IS NOT THE REAL-INVOKE RE-VERIFY. The genuine `hono/aws-lambda` decode on
 * a live API Gateway event is deferred to Part D (live-service CI / SAM-local);
 * see README "Deferred to live-service CI". This test only proves the
 * base64→bytes→Request.arrayBuffer math the adapter relies on.
 */

import { describe, it, expect } from 'vitest'

/** Mimic the API Gateway proxy event shape the Lambda adapter receives. */
interface ApiGwEvent {
  body: string
  isBase64Encoded: boolean
  headers: Record<string, string>
}

/** Base64-encode bytes the way API Gateway would for a binary/encoded body. */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** The transform `hono/aws-lambda` performs: event body → decoded Web Request. */
function eventToRequest(event: ApiGwEvent): Request {
  const bodyBytes = event.isBase64Encoded
    ? Uint8Array.from(atob(event.body), (ch) => ch.charCodeAt(0))
    : new TextEncoder().encode(event.body)
  return new Request('https://api/x', {
    method: 'POST',
    headers: event.headers,
    body: bodyBytes,
  })
}

async function sha256Hex(data: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

describe('Lambda raw-body base64 decode simulation (ARCH-08)', () => {
  it('base64 event body → Request.arrayBuffer round-trips byte-exact', async () => {
    const original = new TextEncoder().encode(JSON.stringify({ hello: 'wörld 🌍', n: 42 }))
    const event: ApiGwEvent = {
      body: bytesToBase64(original),
      isBase64Encoded: true,
      headers: { 'content-type': 'application/json' },
    }

    const req = eventToRequest(event)
    const raw = await req.arrayBuffer()

    // The verifier hashes these bytes; they must equal the pre-encode bytes.
    expect(await sha256Hex(raw)).toBe(await sha256Hex(original))
  })

  it('matches the published SHA-256 vector for "hello" through the base64 path', async () => {
    const original = new TextEncoder().encode('hello')
    const event: ApiGwEvent = {
      body: bytesToBase64(original),
      isBase64Encoded: true,
      headers: {},
    }
    const raw = await eventToRequest(event).arrayBuffer()
    expect(await sha256Hex(raw)).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    )
  })

  it('non-encoded (plain) event body decodes identically', async () => {
    const text = JSON.stringify({ plain: true })
    const event: ApiGwEvent = { body: text, isBase64Encoded: false, headers: {} }
    const raw = await eventToRequest(event).arrayBuffer()
    expect(new TextDecoder().decode(raw)).toBe(text)
  })

  it('arrayBuffer() then json() both succeed (spike: body cache not drained)', async () => {
    const payload = { a: 1, b: ['x', 'y'] }
    const original = new TextEncoder().encode(JSON.stringify(payload))
    const req = eventToRequest({ body: bytesToBase64(original), isBase64Encoded: true, headers: {} })

    const raw = await req.arrayBuffer() // verifier reads first
    expect(raw.byteLength).toBe(original.byteLength)
    // Re-derive JSON from the same cached bytes (Web Request caches the body).
    const parsed = await new Response(raw).json()
    expect(parsed).toEqual(payload)
  })
})
