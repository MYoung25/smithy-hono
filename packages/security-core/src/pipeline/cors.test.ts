import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { cors } from './cors.js'
import type { CorsPipelineConfig } from './cors.js'

const ORIGIN = 'https://app.example.com'

function makeConfig(overrides: Partial<CorsPipelineConfig> = {}): CorsPipelineConfig {
  return {
    allowedOrigins: [ORIGIN],
    hsts: { maxAge: 31536000, includeSubDomains: true },
    idleTtlSeconds: 900,
    stores: {},
    ...overrides,
  }
}

/**
 * Build an app guarded by `cors`. The downstream handler throws on `OPTIONS` so a
 * test fails loudly if the preflight short-circuit ever falls through.
 */
function buildApp(config: CorsPipelineConfig) {
  let downstreamHit = false
  const app = new Hono()
  app.use('*', cors(config))
  app.all('*', (c) => {
    downstreamHit = true
    if (c.req.method === 'OPTIONS') {
      throw new Error('preflight reached the downstream handler — short-circuit failed')
    }
    return c.json({ ok: true })
  })
  return { app, wasDownstreamHit: () => downstreamHit }
}

describe('cors (S8) — OPTIONS preflight short-circuit', () => {
  it('allowed origin → 204 with full CORS headers, never reaches downstream', async () => {
    const { app, wasDownstreamHit } = buildApp(makeConfig())
    const res = await app.request('/todos', {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN },
    })

    expect(res.status).toBe(204)
    expect(wasDownstreamHit()).toBe(false) // short-circuit: never hits the handler
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true')
    expect(res.headers.get('Vary')).toBe('Origin')
    expect(res.headers.get('Access-Control-Allow-Methods')).toBeTruthy()
    expect(res.headers.get('Access-Control-Allow-Headers')).toBeTruthy()
    expect(res.headers.get('Access-Control-Max-Age')).toBeTruthy()
  })

  it('honors configured methods/headers/maxAge on the preflight response', async () => {
    const { app } = buildApp(
      makeConfig({
        cors: {
          allowedMethods: ['GET', 'POST'],
          allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
          maxAgeSeconds: 1234,
        },
      }),
    )
    const res = await app.request('/todos', {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN },
    })

    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST')
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, X-CSRF-Token')
    expect(res.headers.get('Access-Control-Max-Age')).toBe('1234')
  })

  it('disallowed origin → 204 with NO ACAO headers but still Vary: Origin', async () => {
    const { app } = buildApp(makeConfig())
    const res = await app.request('/todos', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example.com' },
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull()
    expect(res.headers.get('Access-Control-Allow-Methods')).toBeNull()
    // PIPELINE-MW-06: Vary: Origin is emitted on every CORS-relevant response.
    expect(res.headers.get('Vary')).toBe('Origin')
  })

  it('no Origin header at all → 204 with NO ACAO but still Vary: Origin', async () => {
    const { app } = buildApp(makeConfig())
    const res = await app.request('/todos', { method: 'OPTIONS' })

    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    // PIPELINE-MW-06: Vary: Origin advertised even when no Origin was sent.
    expect(res.headers.get('Vary')).toBe('Origin')
  })
})

describe('cors (S8) — actual requests', () => {
  it('allowed origin → CORS headers set + handler reached', async () => {
    const { app, wasDownstreamHit } = buildApp(makeConfig())
    const res = await app.request('/todos', { headers: { Origin: ORIGIN } })

    expect(res.status).toBe(200)
    expect(wasDownstreamHit()).toBe(true)
    expect(await res.json()).toEqual({ ok: true })
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true')
    expect(res.headers.get('Vary')).toBe('Origin')
  })

  it('disallowed origin → no ACAO headers but still Vary: Origin, handler still reached', async () => {
    const { app, wasDownstreamHit } = buildApp(makeConfig())
    const res = await app.request('/todos', {
      headers: { Origin: 'https://evil.example.com' },
    })

    expect(res.status).toBe(200)
    expect(wasDownstreamHit()).toBe(true)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull()
    // PIPELINE-MW-06: Vary: Origin emitted even on the disallowed-actual path.
    expect(res.headers.get('Vary')).toBe('Origin')
  })

  it('PIPELINE-MW-05: merges Vary: Origin with a downstream-set Vary instead of clobbering it', async () => {
    const app = new Hono()
    app.use('*', cors(makeConfig()))
    app.all('*', (c) => {
      // A downstream contributor (e.g. content negotiation) sets its own Vary.
      c.header('Vary', 'Accept-Encoding')
      return c.json({ ok: true })
    })
    const res = await app.request('/todos', { headers: { Origin: ORIGIN } })

    const vary = res.headers.get('Vary') ?? ''
    const tokens = vary.split(',').map((t) => t.trim())
    expect(tokens).toContain('Origin')
    expect(tokens).toContain('Accept-Encoding')
  })

  it('PIPELINE-MW-05: does not duplicate Origin when downstream already varies on it', async () => {
    const app = new Hono()
    app.use('*', cors(makeConfig()))
    app.all('*', (c) => {
      c.header('Vary', 'Origin')
      return c.json({ ok: true })
    })
    const res = await app.request('/todos', { headers: { Origin: ORIGIN } })

    const tokens = (res.headers.get('Vary') ?? '').split(',').map((t) => t.trim())
    expect(tokens.filter((t) => t.toLowerCase() === 'origin')).toHaveLength(1)
  })

  it('emits Access-Control-Expose-Headers only when configured', async () => {
    const withExpose = buildApp(makeConfig({ cors: { exposeHeaders: ['X-Request-Id'] } }))
    const res1 = await withExpose.app.request('/todos', { headers: { Origin: ORIGIN } })
    expect(res1.headers.get('Access-Control-Expose-Headers')).toBe('X-Request-Id')

    const noExpose = buildApp(makeConfig())
    const res2 = await noExpose.app.request('/todos', { headers: { Origin: ORIGIN } })
    expect(res2.headers.get('Access-Control-Expose-Headers')).toBeNull()
  })

  it('never emits a wildcard Access-Control-Allow-Origin', async () => {
    const { app } = buildApp(makeConfig())
    // Allowed actual request.
    const allowed = await app.request('/todos', { headers: { Origin: ORIGIN } })
    expect(allowed.headers.get('Access-Control-Allow-Origin')).not.toBe('*')
    // Allowed preflight.
    const preflight = await app.request('/todos', {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN },
    })
    expect(preflight.headers.get('Access-Control-Allow-Origin')).not.toBe('*')
  })
})
