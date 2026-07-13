import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { errorSanitizer, isModeledError, serializeForLog } from './errorSanitizer.js'
import { requestId } from './requestId.js'
import type { SecurityConfig, Logger } from '../config.js'
import type { SecurityEnv } from './context.js'

function fakeLogger(): Logger & { errors: Record<string, unknown>[] } {
  const errors: Record<string, unknown>[] = []
  return {
    errors,
    info: () => {},
    warn: () => {},
    error: (rec) => errors.push(rec),
  }
}

function baseConfig(overrides: Partial<SecurityConfig> = {}): SecurityConfig {
  return {
    allowedOrigins: [],
    hsts: { maxAge: 31536000, includeSubDomains: true },
    idleTtlSeconds: 900,
    stores: {},
    ...overrides,
  }
}

/** The generated-error brand (RT-08); the SmithyError base stamps it in its ctor. */
const MODELED_ERROR_BRAND = Symbol.for('@smithy-hono/security-core/modeled-error')

/** A genuinely-modeled error: a structural shape carrying the generated brand. */
function modeled(fields: { name: string; $statusCode: number; message?: string; code?: string }) {
  return { ...fields, [MODELED_ERROR_BRAND]: true }
}

/** Build an app that throws `thrown` from the handler, behind the sanitizer. */
function app(config: SecurityConfig, thrown: unknown): Hono<SecurityEnv> {
  const a = new Hono<SecurityEnv>()
  a.use('*', requestId())
  a.use('*', errorSanitizer(config))
  a.get('/', () => {
    throw thrown
  })
  return a
}

describe('isModeledError — branded modeled errors (HDR-05, RT-08)', () => {
  it('is true for a BRANDED object with numeric $statusCode and string name', () => {
    expect(isModeledError(modeled({ name: 'NotFound', $statusCode: 404 }))).toBe(true)
  })

  it('is false for an UNBRANDED $statusCode-bearing object (RT-08 spoof)', () => {
    // A library/internal error that merely happens to carry $statusCode + name must
    // NOT be treated as modeled — otherwise its message would leak to the client.
    expect(isModeledError({ name: 'NotFound', $statusCode: 404 })).toBe(false)
  })

  it('is false for a plain Error (no brand, no $statusCode)', () => {
    expect(isModeledError(new Error('boom'))).toBe(false)
  })

  it('is false for non-objects and a branded-but-invalid $statusCode', () => {
    expect(isModeledError('string')).toBe(false)
    expect(isModeledError(null)).toBe(false)
    expect(isModeledError(undefined)).toBe(false)
    expect(isModeledError(modeled({ name: 'X', $statusCode: '404' as unknown as number }))).toBe(false)
    expect(isModeledError(modeled({ name: 'X', $statusCode: Number.NaN }))).toBe(false)
  })
})

describe('serializeForLog', () => {
  it('extracts name/message/stack from an Error', () => {
    const out = serializeForLog(new Error('boom'))
    expect(out['name']).toBe('Error')
    expect(out['message']).toBe('boom')
    expect('stack' in out).toBe(true)
  })

  it('handles a non-Error throw safely', () => {
    expect(serializeForLog('just a string')['name']).toBe('NonError')
    expect(serializeForLog({ foo: 1 })['name']).toBe('NonError')
  })

  it('scrubs common secret shapes from message/stack (AUDIT-LOGGING-06)', () => {
    const out = serializeForLog(
      new Error('auth failed: Authorization=Bearer abc.def.ghi token=s3cr3t-value'),
    )
    const message = out['message'] as string
    expect(message).not.toContain('abc.def.ghi')
    expect(message).not.toContain('s3cr3t-value')
    expect(message).toContain('[REDACTED]')
  })

  it('scrubs JWT-shaped strings and connection-string credentials', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJ'
    const out = serializeForLog(new Error(`token ${jwt} db postgres://user:p4ss@host/db`))
    const message = out['message'] as string
    expect(message).not.toContain(jwt)
    expect(message).not.toContain('p4ss')
    expect(message).toContain('[REDACTED]')
  })

  it('truncates very long error text', () => {
    const out = serializeForLog(new Error('x'.repeat(10_000)))
    expect((out['message'] as string).length).toBeLessThan(10_000)
    expect(out['message']).toContain('[truncated]')
  })
})

describe('errorSanitizer — modeled errors pass through (HDR-05)', () => {
  it('maps a modeled error to its $statusCode with code/message + requestId', async () => {
    const err = modeled({
      name: 'TodoNotFound',
      message: 'no such todo',
      $statusCode: 404,
      code: 'TodoNotFound',
    })
    const res = await app(baseConfig(), err).request('/')
    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('TodoNotFound')
    expect(body['message']).toBe('no such todo')
    expect(typeof body['requestId']).toBe('string')
    expect(res.headers.get('X-Request-Id')).toBe(body['requestId'])
  })

  it('falls back to name when code is absent', async () => {
    const err = modeled({ name: 'Conflict', message: 'dup', $statusCode: 409 })
    const res = await app(baseConfig(), err).request('/')
    expect(res.status).toBe(409)
    expect((await res.json() as Record<string, unknown>)['code']).toBe('Conflict')
  })
})

describe('errorSanitizer — unmodeled errors become a sanitized 500 (HDR-05)', () => {
  it('returns a generic 500 with InternalServerError + requestId, leaking nothing', async () => {
    const logger = fakeLogger()
    const secret = new Error('DB password is hunter2 at 10.0.0.5')
    const res = await app(baseConfig({ logger }), secret).request('/')

    expect(res.status).toBe(500)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual({
      code: 'InternalServerError',
      message: 'Internal server error',
      requestId: body['requestId'],
    })
    expect(typeof body['requestId']).toBe('string')

    // The client body must NOT leak the internal message or stack.
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('hunter2')
    expect(serialized).not.toContain('10.0.0.5')
    expect(serialized).not.toContain('stack')
  })

  it('sends full detail to the logger only (logs, not the client)', async () => {
    const logger = fakeLogger()
    const secret = new Error('DB password is hunter2')
    await app(baseConfig({ logger }), secret).request('/')

    expect(logger.errors).toHaveLength(1)
    const logged = logger.errors[0]!
    expect(typeof logged['requestId']).toBe('string')
    const err = logged['err'] as Record<string, unknown>
    expect(err['message']).toBe('DB password is hunter2')
    expect('stack' in err).toBe(true)
  })

  it('handles a non-Error throw → still a sanitized 500', async () => {
    const res = await app(baseConfig(), 'raw string boom').request('/')
    expect(res.status).toBe(500)
    expect((await res.json() as Record<string, unknown>)['code']).toBe('InternalServerError')
  })

  it('does not throw when no logger is configured', async () => {
    const res = await app(baseConfig(), new Error('boom')).request('/')
    expect(res.status).toBe(500)
  })

  it('has the canonical phase name', () => {
    expect(errorSanitizer(baseConfig()).name).toBe('errorSanitizer')
  })
})
