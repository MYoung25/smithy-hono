import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { structuredLogger } from './logging.js'
import { requestId } from './requestId.js'
import type { SecurityConfig, Logger, MetricsSink, MetricSignal } from '../config.js'
import type { Principal } from '../storage/index.js'
import type { SecurityEnv } from './context.js'

/** A capturing MetricsSink that records every emitted signal. */
function captureMetrics(): MetricsSink & { signals: MetricSignal[] } {
  const signals: MetricSignal[] = []
  return { signals, emit: (s) => signals.push(s) }
}

/** A fake Logger that records every record passed to each level. */
function fakeLogger(): Logger & { records: { level: string; rec: Record<string, unknown> }[] } {
  const records: { level: string; rec: Record<string, unknown> }[] = []
  return {
    records,
    info: (rec) => records.push({ level: 'info', rec }),
    warn: (rec) => records.push({ level: 'warn', rec }),
    error: (rec) => records.push({ level: 'error', rec }),
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

const SAMPLE_PRINCIPAL: Principal = {
  id: 'user-42',
  permissions: [],
  claims: {},
  kind: 'user',
}

function app(config: SecurityConfig, opts: { principal?: Principal } = {}): Hono<SecurityEnv> {
  const a = new Hono<SecurityEnv>()
  a.use('*', requestId())
  a.use('*', structuredLogger(config))
  a.get('/todos/:id', (c) => {
    if (opts.principal) c.set('principal', opts.principal)
    return c.json({ id: c.req.param('id') })
  })
  return a
}

describe('structuredLogger — one line per request (LOG-01/04)', () => {
  it('emits exactly one info record with the expected metadata fields', async () => {
    const logger = fakeLogger()
    const res = await app(baseConfig({ logger })).request('/todos/abc')
    expect(res.status).toBe(200)

    const infos = logger.records.filter((r) => r.level === 'info')
    expect(infos).toHaveLength(1)
    const rec = infos[0]!.rec
    expect(rec).toMatchObject({
      method: 'GET',
      // Route TEMPLATE, not the concrete path — an `@httpLabel` value can be PII.
      path: '/todos/:id',
      status: 200,
    })
    expect(typeof rec['requestId']).toBe('string')
    expect(typeof rec['durationMs']).toBe('number')
    expect(rec['durationMs']).toBeGreaterThanOrEqual(0)
  })

  it('NEVER logs token/cookie/authorization/body fields', async () => {
    const logger = fakeLogger()
    await app(baseConfig({ logger })).request('/todos/abc', {
      headers: {
        Authorization: 'Bearer super-secret-token',
        Cookie: '__Host-session=secretvalue',
      },
    })
    const rec = logger.records.find((r) => r.level === 'info')!.rec
    const keys = Object.keys(rec)
    expect(keys).not.toContain('authorization')
    expect(keys).not.toContain('Authorization')
    expect(keys).not.toContain('cookie')
    expect(keys).not.toContain('Cookie')
    expect(keys).not.toContain('token')
    expect(keys).not.toContain('body')
    // And no value carries the secret material.
    const serialized = JSON.stringify(rec)
    expect(serialized).not.toContain('super-secret-token')
    expect(serialized).not.toContain('secretvalue')
  })

  it('logs the route template, not a PII path-label value (LOG-04)', async () => {
    const logger = fakeLogger()
    // A request whose path label is an email — a common PII-in-path REST shape.
    await app(baseConfig({ logger })).request('/todos/john@example.com')
    const rec = logger.records.find((r) => r.level === 'info')!.rec
    expect(rec['path']).toBe('/todos/:id')
    expect(JSON.stringify(rec)).not.toContain('john@example.com')
  })

  it('does not leak the concrete path when no route matched (404)', async () => {
    const logger = fakeLogger()
    // Hono reports a non-PII sentinel template ('/*') for an unmatched route, so
    // an unmatched request never writes its raw (possibly PII) path to the log.
    await app(baseConfig({ logger })).request('/no-such-route/john@example.com')
    const rec = logger.records.find((r) => r.level === 'info')!.rec
    expect(rec['path']).toBe('/*')
    expect(JSON.stringify(rec)).not.toContain('john@example.com')
  })

  it('logs a pseudonymized principal reference (never the raw id)', async () => {
    const logger = fakeLogger()
    await app(baseConfig({ logger }), { principal: SAMPLE_PRINCIPAL }).request('/todos/abc')
    const rec = logger.records.find((r) => r.level === 'info')!.rec
    expect(rec['principal']).toBeTruthy()
    expect(rec['principal']).not.toBe('user-42')
  })

  it('logs principal:null when there is no principal', async () => {
    const logger = fakeLogger()
    await app(baseConfig({ logger })).request('/todos/abc')
    const rec = logger.records.find((r) => r.level === 'info')!.rec
    expect(rec['principal']).toBeNull()
  })

  it('a throwing logger does not break the request (best-effort)', async () => {
    const throwingLogger: Logger = {
      info: () => {
        throw new Error('transport down')
      },
      warn: () => {},
      error: () => {},
    }
    const res = await app(baseConfig({ logger: throwingLogger })).request('/todos/abc')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'abc' })
  })

  it('passes through with no logger configured (logging off)', async () => {
    const res = await app(baseConfig()).request('/todos/abc')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'abc' })
  })

  it('has the canonical phase name in both on and off modes', () => {
    expect(structuredLogger(baseConfig({ logger: fakeLogger() })).name).toBe('structuredLogger')
    expect(structuredLogger(baseConfig()).name).toBe('structuredLogger')
  })
})

describe('structuredLogger — LOG-08 http.5xx signal', () => {
  /** App whose route returns the given status. */
  function statusApp(config: SecurityConfig, status: number): Hono<SecurityEnv> {
    const a = new Hono<SecurityEnv>()
    a.use('*', requestId())
    a.use('*', structuredLogger(config))
    a.get('/x', (c) => c.json({ ok: false }, status as never))
    return a
  }

  it('emits one http.5xx signal for a 5xx response', async () => {
    const metrics = captureMetrics()
    await statusApp(baseConfig({ metrics }), 503).request('/x')
    expect(metrics.signals).toHaveLength(1)
    expect(metrics.signals[0]!.type).toBe('http.5xx')
    expect(metrics.signals[0]!.labels).toEqual({ status: 503 })
  })

  it('emits NO signal for a 2xx/4xx response', async () => {
    const metrics = captureMetrics()
    await statusApp(baseConfig({ metrics }), 200).request('/x')
    await statusApp(baseConfig({ metrics }), 429).request('/x')
    expect(metrics.signals).toHaveLength(0)
  })

  it('fires the 5xx signal even when no request logger is configured', async () => {
    const metrics = captureMetrics()
    // No `logger` — metrics and logging are independent concerns.
    await statusApp(baseConfig({ metrics }), 500).request('/x')
    expect(metrics.signals.map((s) => s.type)).toEqual(['http.5xx'])
  })

  it('passes through (no signal, no throw) when neither logger nor metrics is set', async () => {
    const res = await statusApp(baseConfig(), 500).request('/x')
    expect(res.status).toBe(500)
  })
})
