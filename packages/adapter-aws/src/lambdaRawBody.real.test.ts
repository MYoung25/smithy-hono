/**
 * ARCH-08 (SIGN-07) Lambda raw-body — REAL `hono/aws-lambda` decode path.
 *
 * Complements lambdaRawBody.test.ts (which only simulates the math): this drives
 * the ACTUAL `hono/aws-lambda` adapter — `handle(app)` fed a synthetic API
 * Gateway proxy event with an `isBase64Encoded` body — and asserts that inside
 * the handler `readRawBody(c)` (= `c.req.arrayBuffer()`, the bytes the verifier
 * hashes) yields the DECODED original bytes, AND that a subsequent `c.req.json()`
 * still parses (the body-cache property the spike relied on, now across the real
 * Lambda event→Request transform).
 *
 * No Docker, no AWS, no extra install: `hono/aws-lambda` is a subpath of the
 * `hono` devDependency. The only thing this canNOT cover is a genuine deployed
 * invoke (real API Gateway → Lambda networking), which remains a deploy-smoke
 * concern, not an adapter-logic one.
 */

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { handle } from 'hono/aws-lambda'
import { readRawBody } from '@smithy-hono/security-core'

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function base64(s: string): string {
  let bin = ''
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** Minimal API Gateway REST (v1) proxy event with a base64 body. */
function apiGwV1Event(rawBody: string, isBase64Encoded: boolean): Record<string, unknown> {
  return {
    httpMethod: 'POST',
    path: '/verify',
    headers: { 'content-type': 'application/json' },
    multiValueHeaders: {},
    body: isBase64Encoded ? base64(rawBody) : rawBody,
    isBase64Encoded,
    requestContext: { http: { method: 'POST' } },
    resource: '/verify',
    queryStringParameters: null,
  }
}

describe('Lambda raw-body — real hono/aws-lambda decode (ARCH-08)', () => {
  // An app whose handler does exactly what the S6 verifier does: read the raw
  // body (hash it), then parse JSON from the same request.
  const app = new Hono()
  app.post('/verify', async (c) => {
    const raw = await readRawBody(c)
    const hash = await sha256Hex(raw)
    const json = await c.req.json()
    return c.json({ hash, byteLength: raw.byteLength, json })
  })
  const handler = handle(app)

  it('decodes a base64 event body so readRawBody sees the original bytes', async () => {
    const bodyText = JSON.stringify({ hello: 'wörld 🌍', n: 42 })
    const expectedHash = await sha256Hex(
      new TextEncoder().encode(bodyText).buffer as ArrayBuffer,
    )

    const res = (await handler(apiGwV1Event(bodyText, true) as never, {} as never)) as {
      statusCode: number
      body: string
    }

    expect(res.statusCode).toBe(200)
    const out = JSON.parse(res.body)
    // readRawBody hashed the DECODED bytes (== what the client signed) ...
    expect(out.hash).toBe(expectedHash)
    expect(out.byteLength).toBe(new TextEncoder().encode(bodyText).byteLength)
    // ... and c.req.json() still parsed the same body afterward (body cache).
    expect(out.json).toEqual({ hello: 'wörld 🌍', n: 42 })
  })

  it('handles a non-base64 event body identically', async () => {
    const bodyText = JSON.stringify({ plain: true })
    const res = (await handler(apiGwV1Event(bodyText, false) as never, {} as never)) as {
      statusCode: number
      body: string
    }
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).json).toEqual({ plain: true })
  })
})
