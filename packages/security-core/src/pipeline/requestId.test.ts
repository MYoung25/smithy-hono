import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { requestId } from './requestId.js'
import type { SecurityEnv } from './context.js'

function app(): Hono<SecurityEnv> {
  const a = new Hono<SecurityEnv>()
  a.use('*', requestId())
  a.get('/', (c) => c.json({ id: c.get('requestId') }))
  a.get('/boom', () => {
    throw new Error('inner failure')
  })
  return a
}

describe('requestId — correlation id on every response (LOG-01)', () => {
  it('mints an id and sets X-Request-Id on a successful response', async () => {
    const res = await app().request('/')
    const header = res.headers.get('X-Request-Id')
    expect(header).toBeTruthy()
    // The header value matches the id set on context (echoed in the body).
    expect(await res.json()).toEqual({ id: header })
  })

  it('honors a sanitized incoming X-Request-Id', async () => {
    const incoming = 'trace-abc.123:def'
    const res = await app().request('/', { headers: { 'X-Request-Id': incoming } })
    expect(res.headers.get('X-Request-Id')).toBe(incoming)
    expect(await res.json()).toEqual({ id: incoming })
  })

  it('regenerates when the incoming id has illegal characters (log-forging defense)', async () => {
    // Spaces/slashes are outside the conservative token charset (a newline can't be
    // sent through the fetch Headers constructor, so we exercise the regex with
    // other disallowed characters that headers do permit).
    const dirty = 'bad value/with spaces'
    const res = await app().request('/', { headers: { 'X-Request-Id': dirty } })
    const header = res.headers.get('X-Request-Id')
    expect(header).not.toBe(dirty)
    expect(header).toMatch(/^[A-Za-z0-9._-]+$/)
  })

  it('regenerates when the incoming id is over the length cap', async () => {
    const huge = 'a'.repeat(500)
    const res = await app().request('/', { headers: { 'X-Request-Id': huge } })
    expect(res.headers.get('X-Request-Id')).not.toBe(huge)
  })

  it('regenerates when the incoming id is empty', async () => {
    const res = await app().request('/', { headers: { 'X-Request-Id': '' } })
    expect(res.headers.get('X-Request-Id')).toBeTruthy()
  })

  it('mints unique ids across requests', async () => {
    const a = app()
    const r1 = await a.request('/')
    const r2 = await a.request('/')
    expect(r1.headers.get('X-Request-Id')).not.toBe(r2.headers.get('X-Request-Id'))
  })

  it('still sets X-Request-Id when an inner handler throws', async () => {
    // Without an error boundary, an inner throw yields a 500 — the header must
    // still ride out (set on the way out covers the rejection path).
    const res = await app().request('/boom')
    expect(res.status).toBe(500)
    expect(res.headers.get('X-Request-Id')).toBeTruthy()
  })

  it('sets X-Request-Id on a 404 (no route matched downstream)', async () => {
    const res = await app().request('/no-such-route')
    expect(res.status).toBe(404)
    expect(res.headers.get('X-Request-Id')).toBeTruthy()
  })

  it('has the canonical phase name', () => {
    expect(requestId().name).toBe('requestId')
  })
})
