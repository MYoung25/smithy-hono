import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { inMemoryFetch } from './transport.js'

function echoApp() {
  const app = new Hono()
  app.all('/echo', async (c) => {
    const body = c.req.header('content-type')?.includes('json') ? await c.req.json().catch(() => null) : null
    return c.json({
      method: c.req.method,
      proto: c.req.header('x-forwarded-proto') ?? null,
      cookie: c.req.header('cookie') ?? null,
      sig: c.req.header('x-sig') ?? null,
      body,
    })
  })
  return app
}

describe('inMemoryFetch', () => {
  it('dispatches into the app and returns its Response', async () => {
    const f = inMemoryFetch(echoApp())
    const res = await f('/echo')
    expect(res.status).toBe(200)
    expect((await res.json()).method).toBe('GET')
  })

  it('adds defaultHeaders only when absent; overrideHeaders always win', async () => {
    const f = inMemoryFetch(echoApp(), {
      defaultHeaders: { 'x-forwarded-proto': 'https' },
      overrideHeaders: { cookie: 'forced=1' },
    })
    const res = await f('/echo', { headers: { cookie: 'ignored=1' } })
    const json = await res.json()
    expect(json.proto).toBe('https')
    expect(json.cookie).toBe('forced=1') // override beat the per-request cookie
  })

  it('runs the sign hook last with method/url/body and attaches its headers', async () => {
    const seen: Record<string, unknown> = {}
    const f = inMemoryFetch(echoApp(), {
      sign: (req) => {
        seen.method = req.method
        seen.url = req.url
        seen.body = req.body
        return { 'x-sig': 'abc' }
      },
    })
    const res = await f('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hi: 1 }),
    })
    const json = await res.json()
    expect(json.sig).toBe('abc')
    expect(seen.method).toBe('POST')
    expect(seen.url).toBe('/echo')
    expect(seen.body).toBe('{"hi":1}')
    expect(json.body).toEqual({ hi: 1 })
  })

  it('passes a URLSearchParams body to the sign hook as its serialized bytes, not undefined', async () => {
    let seenBody: unknown
    const f = inMemoryFetch(echoApp(), {
      sign: (req) => {
        seenBody = req.body
        return {}
      },
    })
    await f('/echo', { method: 'POST', body: new URLSearchParams({ a: '1', b: '2' }) })
    // Previously any non-string body was dropped to undefined (signing an empty body).
    expect(seenBody).toBe('a=1&b=2')
  })

  it('passes a Uint8Array body through to the sign hook as the real bytes', async () => {
    let seenBody: unknown
    const bytes = new TextEncoder().encode('raw-bytes')
    const f = inMemoryFetch(echoApp(), {
      sign: (req) => {
        seenBody = req.body
        return {}
      },
    })
    await f('/echo', { method: 'POST', body: bytes })
    expect(seenBody).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(seenBody as Uint8Array)).toBe('raw-bytes')
  })
})
