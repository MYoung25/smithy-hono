import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { awsForwardedProto, awsClientIp, createConsoleLogger } from './glue.js'

/** Drive a resolver through a real Hono Context built from a Request. */
async function withContext<T>(
  headers: Record<string, string>,
  fn: (c: Context) => T,
): Promise<T> {
  const app = new Hono()
  let captured: T
  app.get('/', (c) => {
    captured = fn(c)
    return c.text('ok')
  })
  await app.request('http://x/', { headers })
  return captured!
}

/**
 * Drive a resolver with both request headers and a Lambda request context bound
 * to `c.env` — mirroring how `hono/aws-lambda` exposes the raw event (the third
 * arg to `app.request`/`fetch` becomes `c.env`).
 */
async function withContextAndEnv<T>(
  headers: Record<string, string>,
  env: unknown,
  fn: (c: Context) => T,
): Promise<T> {
  const app = new Hono()
  let captured: T
  app.get('/', (c) => {
    captured = fn(c)
    return c.text('ok')
  })
  await app.request('http://x/', { headers }, env)
  return captured!
}

describe('awsForwardedProto', () => {
  it('reads x-forwarded-proto (default header)', async () => {
    const proto = await withContext({ 'x-forwarded-proto': 'https' }, awsForwardedProto())
    expect(proto).toBe('https')
  })

  it('lowercases and takes the leftmost of a chain', async () => {
    const proto = await withContext({ 'x-forwarded-proto': 'HTTPS, http' }, awsForwardedProto())
    expect(proto).toBe('https')
  })

  it('returns undefined when absent (fail-closed at assertHttps)', async () => {
    const proto = await withContext({}, awsForwardedProto())
    expect(proto).toBeUndefined()
  })

  it('honors an alternate header name (API GW HTTP API)', async () => {
    const resolve = awsForwardedProto({ headerName: 'cloudfront-forwarded-proto' })
    const proto = await withContext({ 'cloudfront-forwarded-proto': 'https' }, resolve)
    expect(proto).toBe('https')
  })

  it('rejects plain http via assertHttps wiring', async () => {
    const proto = await withContext({ 'x-forwarded-proto': 'http' }, awsForwardedProto())
    expect(proto).toBe('http') // assertHttps treats != 'https' as a 400.
  })

  it('with trustEdge:false ignores a spoofed header and reports https from the request context', async () => {
    const resolve = awsForwardedProto({ trustEdge: false })
    const proto = await withContextAndEnv(
      { 'x-forwarded-proto': 'http' }, // attacker tries to force http
      { requestContext: { http: { sourceIp: '203.0.113.5' } } },
      resolve,
    )
    expect(proto).toBe('https') // Function URL is HTTPS-only; header is ignored.
  })

  it('with trustEdge:false fails closed (undefined) when no request context is present', async () => {
    const resolve = awsForwardedProto({ trustEdge: false })
    const proto = await withContext({ 'x-forwarded-proto': 'https' }, resolve)
    expect(proto).toBeUndefined() // no attested invoke → assertHttps rejects.
  })
})

describe('awsClientIp', () => {
  it('takes the leftmost x-forwarded-for entry', async () => {
    const ip = await withContext({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }, awsClientIp())
    expect(ip).toBe('203.0.113.5')
  })

  it('falls back to "unknown" when absent', async () => {
    const ip = await withContext({}, awsClientIp())
    expect(ip).toBe('unknown')
  })

  it('can take the Nth-from-right trusted hop', async () => {
    const resolve = awsClientIp({ trustedHopsFromRight: 1 })
    const ip = await withContext({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' }, resolve)
    expect(ip).toBe('3.3.3.3') // rightmost (1 hop from right)
  })

  it('fails closed on hop underflow instead of the spoofable leftmost entry', async () => {
    // trustedHopsFromRight exceeds the chain length → idx negative. Must NOT fall
    // back to parts[0] (client-controlled); with no attested context IP → 'unknown'.
    const resolve = awsClientIp({ trustedHopsFromRight: 3 })
    const ip = await withContext({ 'x-forwarded-for': '6.6.6.6' }, resolve)
    expect(ip).toBe('unknown')
  })

  it('on hop underflow prefers the AWS-attested request-context IP over spoofable XFF', async () => {
    const resolve = awsClientIp({ trustedHopsFromRight: 5 })
    const ip = await withContextAndEnv(
      { 'x-forwarded-for': '6.6.6.6' }, // too short for 5 hops; must be ignored
      { requestContext: { http: { sourceIp: '203.0.113.9' } } },
      resolve,
    )
    expect(ip).toBe('203.0.113.9')
  })

  it('with trustEdge:false uses the attested request-context IP, not a spoofed XFF', async () => {
    const resolve = awsClientIp({ trustEdge: false })
    const ip = await withContextAndEnv(
      { 'x-forwarded-for': '6.6.6.6' }, // attacker-controlled, must be ignored
      { requestContext: { http: { sourceIp: '203.0.113.5' } } },
      resolve,
    )
    expect(ip).toBe('203.0.113.5')
  })

  it('with trustEdge:false reads the API Gateway v1 identity.sourceIp', async () => {
    const resolve = awsClientIp({ trustEdge: false })
    const ip = await withContextAndEnv(
      { 'x-forwarded-for': '6.6.6.6' },
      { requestContext: { identity: { sourceIp: '198.51.100.7' } } },
      resolve,
    )
    expect(ip).toBe('198.51.100.7')
  })

  it('with trustEdge:false falls back to "unknown" when no request context IP is present', async () => {
    const resolve = awsClientIp({ trustEdge: false })
    const ip = await withContextAndEnv({ 'x-forwarded-for': '6.6.6.6' }, {}, resolve)
    expect(ip).toBe('unknown')
  })
})

describe('createConsoleLogger', () => {
  it('emits one JSON line per level with the level tag', () => {
    const lines: Array<{ level: string; line: string }> = []
    const sink = {
      info: (s: string) => lines.push({ level: 'info', line: s }),
      warn: (s: string) => lines.push({ level: 'warn', line: s }),
      error: (s: string) => lines.push({ level: 'error', line: s }),
    }
    const logger = createConsoleLogger(sink as unknown as typeof console)
    logger.info({ msg: 'hi', requestId: 'r1' })
    logger.error({ msg: 'boom' })
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0]!.line)
    expect(first).toEqual({ level: 'info', msg: 'hi', requestId: 'r1' })
    const second = JSON.parse(lines[1]!.line)
    expect(second.level).toBe('error')
  })
})
