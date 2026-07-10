import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import {
  rateLimitPerIp,
  rateLimitPerPrincipal,
  authRateLimit,
  withTimeout,
  loadShedder,
} from './rateLimit.js'
import type { RateLimitConfig } from './rateLimit.js'
import type { AuditEvent, SecurityConfig } from '../config.js'
import type { Principal, TokenBucketSpec } from '../storage/index.js'
import { MemoryRateLimitStore } from '../storage/memory.js'
import { defaultPseudonymize, pseudonymize } from '../audit/audit.js'
import type { OperationRegistry } from './index.js'
import { resolveOp } from './index.js'
import type { SecurityEnv } from './context.js'

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const OPERATIONS: OperationRegistry = {
  CheapOp: {
    name: 'CheapOp',
    method: 'GET',
    path: '/cheap',
    authSchemes: [{ type: 'anonymous' }],
    readonly: true,
    requiredPermissions: [],
    cost: 1,
    constraints: { hasConstrainedInput: false },
  },
  // RATE-07 — a high-@cost op drains the bucket faster.
  ExpensiveOp: {
    name: 'ExpensiveOp',
    method: 'GET',
    path: '/expensive',
    authSchemes: [{ type: 'anonymous' }],
    readonly: true,
    requiredPermissions: [],
    cost: 5,
    constraints: { hasConstrainedInput: false },
  },
}

const resolve = resolveOp(OPERATIONS)

const PRINCIPAL: Principal = {
  id: 'user-1',
  permissions: [],
  claims: {},
  kind: 'user',
}

/** Base config; per-test we set the store / rateLimits / clientIp we need. */
function makeConfig(
  overrides: Partial<SecurityConfig & RateLimitConfig> = {},
): SecurityConfig & RateLimitConfig {
  return {
    allowedOrigins: ['https://app.example.com'],
    hsts: { maxAge: 31536000, includeSubDomains: true },
    idleTtlSeconds: 900,
    stores: {},
    clientIp: (c) => c.req.header('x-test-ip') ?? '0.0.0.0',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// rateLimitPerIp.
// ---------------------------------------------------------------------------

describe('rateLimitPerIp — coarse per-IP (slot 8)', () => {
  it('bursts over a small bucket → 429 ThrottlingException + integer Retry-After', async () => {
    const config = makeConfig({
      stores: { rateLimit: new MemoryRateLimitStore() },
      rateLimits: { perIp: { capacity: 2, refillPerSecond: 0.1 } },
    })
    const app = new Hono()
    app.use('*', rateLimitPerIp(config, resolve))
    app.get('/cheap', (c) => c.json({ ok: true }))

    const ip = { 'x-test-ip': '1.2.3.4' }
    expect((await app.request('/cheap', { headers: ip })).status).toBe(200)
    expect((await app.request('/cheap', { headers: ip })).status).toBe(200)
    const res = await app.request('/cheap', { headers: ip })
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({
      code: 'ThrottlingException',
      message: 'Too Many Requests',
    })
    const retryAfter = res.headers.get('retry-after')
    expect(retryAfter).not.toBeNull()
    expect(Number.isInteger(Number(retryAfter))).toBe(true)
  })

  it('keys independent buckets per client IP', async () => {
    const config = makeConfig({
      stores: { rateLimit: new MemoryRateLimitStore() },
      rateLimits: { perIp: { capacity: 1, refillPerSecond: 0.1 } },
    })
    const app = new Hono()
    app.use('*', rateLimitPerIp(config, resolve))
    app.get('/cheap', (c) => c.json({ ok: true }))

    // IP A drains its single token, then is throttled.
    expect((await app.request('/cheap', { headers: { 'x-test-ip': 'A' } })).status).toBe(200)
    expect((await app.request('/cheap', { headers: { 'x-test-ip': 'A' } })).status).toBe(429)
    // IP B still has its own full bucket.
    expect((await app.request('/cheap', { headers: { 'x-test-ip': 'B' } })).status).toBe(200)
  })

  it('RATE-07 — a high-@cost op drains the bucket faster than cost-1', async () => {
    const config = makeConfig({
      stores: { rateLimit: new MemoryRateLimitStore() },
      rateLimits: { perIp: { capacity: 5, refillPerSecond: 0.01 } },
    })
    const app = new Hono()
    app.use('*', rateLimitPerIp(config, resolve))
    app.get('/cheap', (c) => c.json({ ok: true }))
    app.get('/expensive', (c) => c.json({ ok: true }))

    const ip = { 'x-test-ip': '9.9.9.9' }
    // cost-5 op empties the capacity-5 bucket in one shot...
    expect((await app.request('/expensive', { headers: ip })).status).toBe(200)
    // ...so the very next request (even a cheap cost-1) is throttled.
    expect((await app.request('/cheap', { headers: ip })).status).toBe(429)
  })

  it('passes through when no rate-limit store is wired', async () => {
    const config = makeConfig({
      rateLimits: { perIp: { capacity: 1, refillPerSecond: 0.1 } },
    })
    const mw = rateLimitPerIp(config, resolve)
    expect(mw.name).toBe('rateLimitPerIp')
    const app = new Hono()
    app.use('*', mw)
    app.get('/cheap', (c) => c.json({ ok: true }))
    expect((await app.request('/cheap')).status).toBe(200)
    expect((await app.request('/cheap')).status).toBe(200)
  })

  it('passes through when rateLimits.perIp is absent', async () => {
    const config = makeConfig({ stores: { rateLimit: new MemoryRateLimitStore() } })
    const app = new Hono()
    app.use('*', rateLimitPerIp(config, resolve))
    app.get('/cheap', (c) => c.json({ ok: true }))
    expect((await app.request('/cheap')).status).toBe(200)
    expect((await app.request('/cheap')).status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// rateLimitPerPrincipal.
// ---------------------------------------------------------------------------

describe('rateLimitPerPrincipal — per-principal (slot 12)', () => {
  function appWith(
    config: SecurityConfig & RateLimitConfig,
    principal?: Principal,
  ): Hono<SecurityEnv> {
    const app = new Hono<SecurityEnv>()
    if (principal) {
      app.use('*', async (c, next) => {
        c.set('principal', principal)
        await next()
      })
    }
    app.use('*', rateLimitPerPrincipal(config, resolve))
    app.get('/cheap', (c) => c.json({ ok: true }))
    return app
  }

  it('throttles by principal.id after draining the bucket', async () => {
    const config = makeConfig({
      stores: { rateLimit: new MemoryRateLimitStore() },
      rateLimits: { perPrincipal: { capacity: 1, refillPerSecond: 0.1 } },
    })
    const app = appWith(config, PRINCIPAL)
    expect((await app.request('/cheap')).status).toBe(200)
    const res = await app.request('/cheap')
    expect(res.status).toBe(429)
    expect((await res.json()).code).toBe('ThrottlingException')
  })

  it('lets anonymous (no principal) traffic bypass the per-principal limiter', async () => {
    const config = makeConfig({
      stores: { rateLimit: new MemoryRateLimitStore() },
      rateLimits: { perPrincipal: { capacity: 1, refillPerSecond: 0.1 } },
    })
    const app = appWith(config) // no principal set
    expect((await app.request('/cheap')).status).toBe(200)
    expect((await app.request('/cheap')).status).toBe(200)
    expect((await app.request('/cheap')).status).toBe(200)
  })

  it('keys independent buckets per principal', async () => {
    const store = new MemoryRateLimitStore()
    const spec: TokenBucketSpec = { capacity: 1, refillPerSecond: 0.1 }
    const a = appWith(
      makeConfig({ stores: { rateLimit: store }, rateLimits: { perPrincipal: spec } }),
      { ...PRINCIPAL, id: 'user-A' },
    )
    const b = appWith(
      makeConfig({ stores: { rateLimit: store }, rateLimits: { perPrincipal: spec } }),
      { ...PRINCIPAL, id: 'user-B' },
    )
    expect((await a.request('/cheap')).status).toBe(200)
    expect((await a.request('/cheap')).status).toBe(429) // user-A drained
    expect((await b.request('/cheap')).status).toBe(200) // user-B independent
  })

  it('passes through when store/spec absent', async () => {
    const mw = rateLimitPerPrincipal(makeConfig(), resolve)
    expect(mw.name).toBe('rateLimitPerPrincipal')
    const app = new Hono<SecurityEnv>()
    app.use('*', async (c, next) => {
      c.set('principal', PRINCIPAL)
      await next()
    })
    app.use('*', mw)
    app.get('/cheap', (c) => c.json({ ok: true }))
    expect((await app.request('/cheap')).status).toBe(200)
    expect((await app.request('/cheap')).status).toBe(200)
  })

  // AUDIT-LOGGING-03 — the ratelimit.trip principalRef must route through the
  // NAMED insecure dev/test fallback (defaultPseudonymize) when no auditSalt is
  // set, and the keyed HMAC when it is — matching pipeline/logging.ts.
  it('pseudonymizes the trip principalRef via defaultPseudonymize when auditSalt is unset', async () => {
    const events: AuditEvent[] = []
    const config = makeConfig({
      stores: { rateLimit: new MemoryRateLimitStore() },
      rateLimits: { perPrincipal: { capacity: 1, refillPerSecond: 0.1 } },
      audit: { async emit(e) { events.push(e) } }, // no auditSalt
    })
    const app = appWith(config, PRINCIPAL)
    await app.request('/cheap')
    expect((await app.request('/cheap')).status).toBe(429)
    const trip = events.find((e) => e.type === 'ratelimit.trip')
    expect(trip?.principalRef).toBe(await defaultPseudonymize(PRINCIPAL.id))
  })

  it('pseudonymizes the trip principalRef via the keyed HMAC when auditSalt IS set', async () => {
    const events: AuditEvent[] = []
    const auditSalt = 'a-high-entropy-deployment-salt-0123456789'
    const config = makeConfig({
      stores: { rateLimit: new MemoryRateLimitStore() },
      rateLimits: { perPrincipal: { capacity: 1, refillPerSecond: 0.1 } },
      audit: { async emit(e) { events.push(e) } },
      auditSalt,
    })
    const app = appWith(config, PRINCIPAL)
    await app.request('/cheap')
    expect((await app.request('/cheap')).status).toBe(429)
    const trip = events.find((e) => e.type === 'ratelimit.trip')
    expect(trip?.principalRef).toBe(await pseudonymize(PRINCIPAL.id, auditSalt))
  })
})

// ---------------------------------------------------------------------------
// RT-07 — a disabled (mounted-but-no-spec/store) limiter must be LOUD.
// ---------------------------------------------------------------------------

describe('RT-07 — disabled-limiter one-time warning', () => {
  function makeLogger() {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  }

  it('rateLimitPerIp warns ONCE when mounted with no store/spec', () => {
    const logger = makeLogger()
    const mw = rateLimitPerIp(makeConfig({ logger }), resolve)
    // Still a graceful pass-through (behavior unchanged)...
    expect(mw.name).toBe('rateLimitPerIp')
    // ...but no longer silent: exactly one construction-time warning.
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0][0]).toMatchObject({
      event: 'ratelimit.disabled',
      limiter: 'rateLimitPerIp',
    })
  })

  it('rateLimitPerPrincipal warns ONCE when mounted with no store/spec', () => {
    const logger = makeLogger()
    const mw = rateLimitPerPrincipal(makeConfig({ logger }), resolve)
    expect(mw.name).toBe('rateLimitPerPrincipal')
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0][0]).toMatchObject({
      event: 'ratelimit.disabled',
      limiter: 'rateLimitPerPrincipal',
    })
  })

  it('the warning names WHY it is disabled (store present, spec missing)', () => {
    const logger = makeLogger()
    // Store wired but no perIp spec → reason should call out the missing spec.
    rateLimitPerIp(
      makeConfig({ logger, stores: { rateLimit: new MemoryRateLimitStore() } }),
      resolve,
    )
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0][0].reason).toBe('no rate-limit spec configured')
  })

  it('does NOT warn when the limiter is fully configured (enabled)', () => {
    const logger = makeLogger()
    rateLimitPerIp(
      makeConfig({
        logger,
        stores: { rateLimit: new MemoryRateLimitStore() },
        rateLimits: { perIp: { capacity: 1, refillPerSecond: 0.1 } },
      }),
      resolve,
    )
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('stays silent (no throw) when no logger is injected', () => {
    expect(() => rateLimitPerIp(makeConfig(), resolve)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// authRateLimit — RATE-03 brute-force helper.
// ---------------------------------------------------------------------------

describe('authRateLimit — RATE-03 brute-force lockout helper', () => {
  it('allows until the strict bucket drains, then denies', async () => {
    const store = new MemoryRateLimitStore()
    const spec: TokenBucketSpec = { capacity: 3, refillPerSecond: 0.001 }
    const key = 'authfail:victim@example.com'

    expect((await authRateLimit(store, key, spec)).allowed).toBe(true)
    expect((await authRateLimit(store, key, spec)).allowed).toBe(true)
    expect((await authRateLimit(store, key, spec)).allowed).toBe(true)
    const locked = await authRateLimit(store, key, spec)
    expect(locked.allowed).toBe(false)
    expect(locked.retryAfterSeconds).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// withTimeout — RATE-04.
// ---------------------------------------------------------------------------

describe('withTimeout — RATE-04 total-processing timeout', () => {
  it('returns 504 when the handler exceeds the budget', async () => {
    const app = new Hono()
    app.use('*', withTimeout(20))
    app.get('/slow', async (c) => {
      await new Promise((r) => setTimeout(r, 100))
      return c.json({ ok: true })
    })
    const res = await app.request('/slow')
    expect(res.status).toBe(504)
    expect(await res.json()).toEqual({ code: 'RequestTimeout', message: 'Request timed out' })
  })

  it('passes a fast handler through unchanged', async () => {
    const app = new Hono()
    app.use('*', withTimeout(1000))
    app.get('/fast', (c) => c.json({ ok: true }))
    const res = await app.request('/fast')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

// ---------------------------------------------------------------------------
// loadShedder — RATE-05.
// ---------------------------------------------------------------------------

describe('loadShedder — RATE-05 in-flight load-shedding', () => {
  it('sheds with 503 over the cap, then frees the slot for a later request', async () => {
    const mw = loadShedder(1)
    expect(mw.name).toBe('loadShedder')

    const app = new Hono()
    app.use('*', mw)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    app.get('/hold', async (c) => {
      await gate
      return c.json({ ok: true })
    })
    app.get('/quick', (c) => c.json({ ok: true }))

    // First request occupies the only slot (still in flight, awaiting the gate).
    const inflight = app.request('/hold')
    await new Promise((r) => setTimeout(r, 0)) // let the handler enter `await gate`
    // Second concurrent request is shed.
    const shed = await app.request('/quick')
    expect(shed.status).toBe(503)
    expect(await shed.json()).toEqual({ code: 'ServiceUnavailable', message: 'Server busy' })

    // Release the held request; its slot frees up.
    release()
    expect((await inflight).status).toBe(200)
    // A later request now passes.
    expect((await app.request('/quick')).status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// LOG-08 — ratelimit.saturation operational signal.
// ---------------------------------------------------------------------------

describe('LOG-08 — limiter emits a ratelimit.saturation signal on deny', () => {
  it('per-IP saturation carries scope=ip and no raw IP', async () => {
    const signals: { type: string; labels?: Record<string, unknown> }[] = []
    const config = makeConfig({
      stores: { rateLimit: new MemoryRateLimitStore() },
      rateLimits: { perIp: { capacity: 1, refillPerSecond: 0.01 } },
      metrics: { emit: (s) => signals.push(s) },
    })
    const app = new Hono<SecurityEnv>()
    app.use('*', rateLimitPerIp(config, resolve))
    app.get('/cheap', (c) => c.json({ ok: true }))

    const ip = { 'x-test-ip': '1.2.3.4' }
    expect((await app.request('/cheap', { headers: ip })).status).toBe(200)
    expect((await app.request('/cheap', { headers: ip })).status).toBe(429)

    const sat = signals.filter((s) => s.type === 'ratelimit.saturation')
    expect(sat).toHaveLength(1)
    expect(sat[0]!.labels).toMatchObject({ scope: 'ip', operation: 'CheapOp' })
    expect(JSON.stringify(sat[0]!.labels)).not.toContain('1.2.3.4')
  })

  it('per-principal saturation carries scope=principal and no raw principal id', async () => {
    const signals: { type: string; labels?: Record<string, unknown> }[] = []
    const config = makeConfig({
      stores: { rateLimit: new MemoryRateLimitStore() },
      rateLimits: { perPrincipal: { capacity: 1, refillPerSecond: 0.01 } },
      metrics: { emit: (s) => signals.push(s) },
    })
    const app = new Hono<SecurityEnv>()
    app.use('*', async (c, next) => {
      c.set('principal', PRINCIPAL)
      await next()
    })
    app.use('*', rateLimitPerPrincipal(config, resolve))
    app.get('/cheap', (c) => c.json({ ok: true }))

    expect((await app.request('/cheap')).status).toBe(200)
    expect((await app.request('/cheap')).status).toBe(429)

    const sat = signals.filter((s) => s.type === 'ratelimit.saturation')
    expect(sat).toHaveLength(1)
    expect(sat[0]!.labels).toMatchObject({ scope: 'principal' })
    expect(JSON.stringify(sat[0]!.labels)).not.toContain('user-1')
  })
})
