/**
 * Unit tests for the Node platform glue: forwarded-proto + client-IP resolvers
 * (driven off real Hono request headers) and the stdout JSON logger sink.
 */

import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  forwardedProtoHeader,
  clientIp,
  clientIpResolver,
  createStdoutLogger,
} from './glue.js'

/** Capture a real Hono Context for a request carrying the given headers. */
async function contextFor(headers: Record<string, string>): Promise<Context> {
  const app = new Hono()
  let captured: Context | undefined
  app.get('/', (c) => {
    captured = c
    return c.text('ok')
  })
  await app.request('http://x/', { headers })
  if (!captured) throw new Error('handler did not run')
  return captured
}

describe('forwardedProtoHeader', () => {
  it('reads X-Forwarded-Proto (lowercased)', async () => {
    const c = await contextFor({ 'x-forwarded-proto': 'HTTPS' })
    expect(forwardedProtoHeader(c)).toBe('https')
  })

  it('takes the leftmost value of a comma chain', async () => {
    const c = await contextFor({ 'x-forwarded-proto': 'https, http' })
    expect(forwardedProtoHeader(c)).toBe('https')
  })

  it('returns undefined when absent (fails closed in assertHttps)', async () => {
    const c = await contextFor({})
    expect(forwardedProtoHeader(c)).toBeUndefined()
  })
})

describe('clientIp', () => {
  it('takes the leftmost XFF entry with a single trusted proxy (default)', async () => {
    const c = await contextFor({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })
    expect(clientIp(c)).toBe('203.0.113.7')
  })

  it('honors trustedHops, taking the entry N positions from the right', async () => {
    // chain: client, proxyA, proxyB (length 3). trustedHops:N takes index length-N,
    // i.e. N positions from the RIGHT — matching awsClientIp's `length - fromRight`.
    const c = await contextFor({ 'x-forwarded-for': 'client-ip, 10.0.0.1, 10.0.0.2' })
    expect(clientIp(c, { trustedHops: 1 })).toBe('10.0.0.2')
    expect(clientIp(c, { trustedHops: 2 })).toBe('10.0.0.1')
  })

  it('clamps trustedHops into range', async () => {
    const c = await contextFor({ 'x-forwarded-for': 'a, b' })
    expect(clientIp(c, { trustedHops: 99 })).toBe('a')
  })

  it('falls back to a constant key when no header (does not fail open)', async () => {
    const c = await contextFor({})
    expect(clientIp(c)).toBe('unknown')
    expect(clientIp(c, { fallback: 'no-ip' })).toBe('no-ip')
  })

  it('clientIpResolver binds options into the (c)=>string hook shape', async () => {
    const c = await contextFor({ 'x-forwarded-for': 'a, b, c' })
    const resolve = clientIpResolver({ trustedHops: 1 })
    expect(resolve(c)).toBe('c')
  })
})

describe('createStdoutLogger', () => {
  it('emits one JSON line per record with level + ts, info→stdout', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const logger = createStdoutLogger({ base: { service: 'todo-api' } })
      logger.info({ msg: 'hello', requestId: 'r1' })
      expect(log).toHaveBeenCalledTimes(1)
      const parsed = JSON.parse(log.mock.calls[0]![0] as string)
      expect(parsed.level).toBe('info')
      expect(parsed.service).toBe('todo-api')
      expect(parsed.msg).toBe('hello')
      expect(parsed.requestId).toBe('r1')
      expect(typeof parsed.ts).toBe('string')
    } finally {
      log.mockRestore()
    }
  })

  it('routes error records to stderr', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      createStdoutLogger().error({ msg: 'boom' })
      expect(err).toHaveBeenCalledTimes(1)
      expect(JSON.parse(err.mock.calls[0]![0] as string).level).toBe('error')
    } finally {
      err.mockRestore()
    }
  })
})
