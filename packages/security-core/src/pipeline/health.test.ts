import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { healthHandler, readinessHandler } from './health.js'
import type { SecurityConfig } from '../config.js'

function config(over: Partial<SecurityConfig> = {}): SecurityConfig {
  return {
    allowedOrigins: [],
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
    idleTtlSeconds: 900,
    stores: {},
    ...over,
  }
}

describe('healthHandler (OPS-04 liveness)', () => {
  it('returns 200 ok', async () => {
    const app = new Hono().get('/healthz', healthHandler())
    const res = await app.request('/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })
})

describe('readinessHandler (OPS-04 readiness)', () => {
  it('returns 200 ready when there are no probes', async () => {
    const app = new Hono().get('/readyz', readinessHandler(config(), { probeStores: false }))
    const res = await app.request('/readyz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ready' })
  })

  it('returns 200 when a custom probe resolves', async () => {
    const app = new Hono().get(
      '/readyz',
      readinessHandler(config(), { probeStores: false, probes: [{ name: 'db', check: async () => {} }] }),
    )
    expect((await app.request('/readyz')).status).toBe(200)
  })

  it('returns 503 with the failed dependency when a probe throws', async () => {
    const app = new Hono().get(
      '/readyz',
      readinessHandler(config(), {
        probeStores: false,
        probes: [
          { name: 'db', check: async () => {} },
          { name: 'cache', check: async () => { throw new Error('down') } },
        ],
      }),
    )
    const res = await app.request('/readyz')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: 'not_ready', failed: ['cache'] })
  })

  it('auto-probes the session store (a thrown get → 503)', async () => {
    const cfg = config({
      stores: { session: { get: async () => { throw new Error('redis down') } } as never },
    })
    const app = new Hono().get('/readyz', readinessHandler(cfg))
    const res = await app.request('/readyz')
    expect(res.status).toBe(503)
    expect((await res.json() as { failed: string[] }).failed).toContain('session')
  })
})
