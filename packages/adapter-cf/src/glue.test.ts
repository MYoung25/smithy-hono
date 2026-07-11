/**
 * Unit tests for the Cloudflare platform glue resolvers. Built against a minimal
 * Hono app/context so we exercise the real `c.req.header(...)` path.
 */

import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { forwardedProtoHeader, clientIp, createConsoleLogger } from './glue.js'

/** Drive a resolver through a real Hono context built from the given headers. */
async function withContext<T>(
  headers: Record<string, string>,
  fn: (c: Context) => T,
): Promise<T> {
  const app = new Hono()
  let captured!: T
  app.get('/', (c) => {
    captured = fn(c)
    return c.text('ok')
  })
  await app.request('http://x/', { headers })
  return captured
}

describe('forwardedProtoHeader', () => {
  it('parses scheme from CF-Visitor JSON', async () => {
    const proto = await withContext(
      { 'cf-visitor': JSON.stringify({ scheme: 'https' }) },
      forwardedProtoHeader,
    )
    expect(proto).toBe('https')
  })

  it('lowercases the CF-Visitor scheme', async () => {
    const proto = await withContext(
      { 'cf-visitor': JSON.stringify({ scheme: 'HTTPS' }) },
      forwardedProtoHeader,
    )
    expect(proto).toBe('https')
  })

  it('falls back to X-Forwarded-Proto (leftmost) when CF-Visitor is absent', async () => {
    const proto = await withContext(
      { 'x-forwarded-proto': 'https, http' },
      forwardedProtoHeader,
    )
    expect(proto).toBe('https')
  })

  it('falls back to X-Forwarded-Proto when CF-Visitor is malformed', async () => {
    const proto = await withContext(
      { 'cf-visitor': 'not json', 'x-forwarded-proto': 'https' },
      forwardedProtoHeader,
    )
    expect(proto).toBe('https')
  })

  it('returns undefined when neither header is present (fails closed for TLS-03)', async () => {
    const proto = await withContext({}, forwardedProtoHeader)
    expect(proto).toBeUndefined()
  })

  it('returns http for a plaintext CF-Visitor (assertHttps will reject)', async () => {
    const proto = await withContext(
      { 'cf-visitor': JSON.stringify({ scheme: 'http' }) },
      forwardedProtoHeader,
    )
    expect(proto).toBe('http')
  })
})

describe('clientIp', () => {
  it('reads CF-Connecting-IP', async () => {
    const ip = await withContext({ 'cf-connecting-ip': '203.0.113.7' }, clientIp)
    expect(ip).toBe('203.0.113.7')
  })

  it('returns "unknown" when the header is absent', async () => {
    const ip = await withContext({}, clientIp)
    expect(ip).toBe('unknown')
  })
})

describe('createConsoleLogger', () => {
  it('emits one JSON line per level with a level field', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const log = createConsoleLogger()
      log.info({ msg: 'hi', requestId: 'r1' })
      log.warn({ msg: 'careful' })
      log.error({ msg: 'boom' })

      expect(info).toHaveBeenCalledOnce()
      expect(JSON.parse(info.mock.calls[0][0] as string)).toEqual({
        level: 'info',
        msg: 'hi',
        requestId: 'r1',
      })
      expect(JSON.parse(warn.mock.calls[0][0] as string).level).toBe('warn')
      expect(JSON.parse(error.mock.calls[0][0] as string).level).toBe('error')
    } finally {
      info.mockRestore()
      warn.mockRestore()
      error.mockRestore()
    }
  })
})
