import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { securityHeaders, assertHttps } from './headers.js'
import type { TransportHeadersConfig } from './headers.js'
import { resolveOp } from './index.js'
import type { OperationRegistry } from './index.js'

// A minimal registry mirroring the codegen-emitted `OPERATIONS` shape: one
// authenticated (oidc) op and one anonymous op, to exercise route-class branches.
const OPERATIONS: OperationRegistry = {
  GetTodo: {
    name: 'GetTodo',
    method: 'GET',
    path: '/todos/:id',
    authSchemes: [{ type: 'oidc' }],
    readonly: true,
    requiredPermissions: ['todos.read'],
    cost: 1,
    constraints: { hasConstrainedInput: false },
  },
  ListTodos: {
    name: 'ListTodos',
    method: 'GET',
    path: '/public',
    authSchemes: [{ type: 'anonymous' }],
    readonly: true,
    requiredPermissions: [],
    cost: 1,
    constraints: { hasConstrainedInput: false },
  },
  // An authenticated streaming (@sseStream) op: exempt from no-store (HDR-07 route-class).
  StreamTodos: {
    name: 'StreamTodos',
    method: 'GET',
    path: '/stream',
    authSchemes: [{ type: 'oidc' }],
    readonly: true,
    streaming: true,
    requiredPermissions: ['todos.read'],
    cost: 1,
    constraints: { hasConstrainedInput: false },
  },
}

const resolve = resolveOp(OPERATIONS)

function makeConfig(
  overrides: Partial<TransportHeadersConfig> = {},
): TransportHeadersConfig {
  return {
    allowedOrigins: ['https://app.example.com'],
    hsts: { maxAge: 31536000, includeSubDomains: true },
    idleTtlSeconds: 900,
    stores: {},
    forwardedProtoHeader: (c) => c.req.header('x-forwarded-proto'),
    ...overrides,
  }
}

describe('securityHeaders — construction validation (TLS-02)', () => {
  it('throws when hsts.maxAge is below one year', () => {
    expect(() =>
      securityHeaders(
        makeConfig({ hsts: { maxAge: 3600, includeSubDomains: true } }),
        resolve,
      ),
    ).toThrow(/maxAge/)
  })

  it('throws on a non-finite maxAge', () => {
    expect(() =>
      securityHeaders(
        makeConfig({ hsts: { maxAge: Number.NaN, includeSubDomains: false } }),
        resolve,
      ),
    ).toThrow(/maxAge/)
  })

  it('accepts exactly one year', () => {
    expect(() =>
      securityHeaders(
        makeConfig({ hsts: { maxAge: 31536000, includeSubDomains: false } }),
        resolve,
      ),
    ).not.toThrow()
  })
})

describe('securityHeaders — header set (HDR-01..04, TLS-02)', () => {
  function appWith(config: TransportHeadersConfig): Hono {
    const app = new Hono()
    app.use('*', securityHeaders(config, resolve))
    app.get('/todos/:id', (c) => c.json({ id: c.req.param('id') }))
    app.get('/public', (c) => c.json({ items: [] }))
    app.get('/stream', (c) => c.json({ items: [] }))
    return app
  }

  it('sets the hardened baseline on every response', async () => {
    const res = await appWith(makeConfig()).request('/todos/abc')
    expect(res.headers.get('Strict-Transport-Security')).toBe(
      'max-age=31536000; includeSubDomains',
    )
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    expect(res.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    )
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
  })

  it('omits includeSubDomains when disabled and adds preload when enabled', async () => {
    const res = await appWith(
      makeConfig({
        hsts: { maxAge: 63072000, includeSubDomains: false },
        headers: { hstsPreload: true },
      }),
    ).request('/public')
    expect(res.headers.get('Strict-Transport-Security')).toBe(
      'max-age=63072000; preload',
    )
  })

  it('sets Cache-Control: no-store on an authenticated route (HDR-07)', async () => {
    const res = await appWith(makeConfig()).request('/todos/abc')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('does not force no-store on an anonymous route', async () => {
    const res = await appWith(makeConfig()).request('/public')
    expect(res.headers.get('Cache-Control')).toBeNull()
  })

  it('exempts an authenticated streaming op from no-store (HDR-07 route-class)', async () => {
    const res = await appWith(makeConfig()).request('/stream')
    expect(res.headers.get('Cache-Control')).toBeNull()
  })

  it('treats an unknown route as authenticated (fail closed → no-store)', async () => {
    const app = new Hono()
    app.use('*', securityHeaders(makeConfig(), resolve))
    app.get('/unknown', (c) => c.json({ ok: true }))
    const res = await app.request('/unknown')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('honors HeadersConfig overrides (ARCH-05)', async () => {
    const res = await appWith(
      makeConfig({
        headers: {
          csp: "default-src 'self'",
          referrerPolicy: 'strict-origin',
          frameOptions: 'SAMEORIGIN',
        },
      }),
    ).request('/public')
    expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'self'")
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin')
    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
  })

  it('emits the deny-by-default Permissions-Policy + CORP + COOP (HDR-08/HDR-10)', async () => {
    const res = await appWith(makeConfig()).request('/public')
    const pp = res.headers.get('Permissions-Policy')
    expect(pp).toBeTruthy()
    // A deny-by-default policy disables the high-risk features (empty allowlist).
    expect(pp).toContain('camera=()')
    expect(pp).toContain('microphone=()')
    expect(pp).toContain('geolocation=()')
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin')
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin')
  })

  it('honors Permissions-Policy / CORP / COOP overrides (ARCH-05)', async () => {
    const res = await appWith(
      makeConfig({
        headers: {
          permissionsPolicy: 'geolocation=(self)',
          corp: 'cross-origin',
          coop: 'same-origin-allow-popups',
        },
      }),
    ).request('/public')
    expect(res.headers.get('Permissions-Policy')).toBe('geolocation=(self)')
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin')
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe(
      'same-origin-allow-popups',
    )
  })

  it('suppresses Permissions-Policy / CORP / COOP when overridden to empty', async () => {
    const res = await appWith(
      makeConfig({
        headers: { permissionsPolicy: '', corp: '', coop: '' },
      }),
    ).request('/public')
    expect(res.headers.get('Permissions-Policy')).toBeNull()
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBeNull()
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBeNull()
  })

  it('has the canonical phase name', () => {
    expect(securityHeaders(makeConfig(), resolve).name).toBe('securityHeaders')
  })
})

describe('assertHttps — reject plaintext (TLS-03)', () => {
  function appWith(config: TransportHeadersConfig): Hono {
    const app = new Hono()
    app.use('*', assertHttps(config))
    app.get('/', (c) => c.json({ ok: true }))
    return app
  }

  it('passes through when forwarded-proto is https', async () => {
    const res = await appWith(makeConfig()).request('/', {
      headers: { 'x-forwarded-proto': 'https' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('rejects with 400 InsecureTransport when proto is http', async () => {
    const res = await appWith(makeConfig()).request('/', {
      headers: { 'x-forwarded-proto': 'http' },
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      code: 'InsecureTransport',
      message: 'HTTPS required',
    })
  })

  it('rejects when the forwarded-proto header is absent', async () => {
    const res = await appWith(makeConfig()).request('/')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      code: 'InsecureTransport',
      message: 'HTTPS required',
    })
  })

  it('reads the proto via the adapter-supplied resolver, not a fixed header', async () => {
    // A Workers-style resolver keying off a different mechanism entirely.
    const config = makeConfig({
      forwardedProtoHeader: (c: Context) =>
        c.req.header('cf-visitor') === '{"scheme":"https"}' ? 'https' : 'http',
    })
    const ok = await appWith(config).request('/', {
      headers: { 'cf-visitor': '{"scheme":"https"}' },
    })
    expect(ok.status).toBe(200)
    const bad = await appWith(config).request('/')
    expect(bad.status).toBe(400)
  })

  // PIPELINE-MW-07: a genuine CORS preflight (OPTIONS + Origin) is exempt from the
  // proto check so it can fall through to cors (slot 6) and be answered there,
  // even over plaintext. The subsequent ACTUAL request still hits assertHttps.
  it('exempts a plaintext OPTIONS preflight (Origin present) — defers to cors', async () => {
    const app = new Hono()
    app.use('*', assertHttps(makeConfig()))
    app.options('/', (c) => c.body(null, 204))

    const res = await app.request('/', {
      method: 'OPTIONS',
      headers: { 'x-forwarded-proto': 'http', Origin: 'https://app.example.com' },
    })
    expect(res.status).toBe(204) // reached the downstream OPTIONS handler, not 400'd
  })

  it('still rejects a plaintext OPTIONS that is NOT a preflight (no Origin)', async () => {
    const app = new Hono()
    app.use('*', assertHttps(makeConfig()))
    app.options('/', (c) => c.body(null, 204))

    const res = await app.request('/', {
      method: 'OPTIONS',
      headers: { 'x-forwarded-proto': 'http' },
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      code: 'InsecureTransport',
      message: 'HTTPS required',
    })
  })

  it('still rejects the plaintext ACTUAL request even after exempting its preflight', async () => {
    const res = await appWith(makeConfig()).request('/', {
      method: 'GET',
      headers: { 'x-forwarded-proto': 'http', Origin: 'https://app.example.com' },
    })
    expect(res.status).toBe(400)
  })

  it('has the canonical phase name', () => {
    expect(assertHttps(makeConfig()).name).toBe('assertHttps')
  })
})
