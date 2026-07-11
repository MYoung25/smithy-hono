import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { csrf } from './csrf.js'
import type { CsrfPipelineConfig } from './csrf.js'
import type { PipelineOperationMeta } from './index.js'
import type { SecurityEnv } from './context.js'
import type { Principal, SessionRecord } from '../storage/index.js'

const CSRF_TOKEN = 'csrf-token-abc123'

function makeConfig(overrides: Partial<CsrfPipelineConfig> = {}): CsrfPipelineConfig {
  return {
    allowedOrigins: ['https://app.example.com'],
    hsts: { maxAge: 31536000, includeSubDomains: true },
    idleTtlSeconds: 900,
    stores: {},
    ...overrides,
  }
}

const PRINCIPAL: Principal = { id: 'u1', permissions: [], claims: {}, kind: 'user' }

function makeSession(csrfToken = CSRF_TOKEN): SessionRecord {
  return {
    principal: PRINCIPAL,
    createdAt: Date.now(),
    absoluteExpiry: Date.now() + 3_600_000,
    csrfToken,
    claims: {},
  }
}

/** A minimal op-meta factory matching the registry shape `csrf` reads. */
function op(readonly: boolean): PipelineOperationMeta {
  return {
    name: 'Op',
    method: 'POST',
    path: '/x',
    authSchemes: [{ type: 'oidc' }],
    readonly,
    requiredPermissions: [],
    cost: 1,
    constraints: { hasConstrainedInput: false },
  }
}

type Resolve = (method: string, path: string) => PipelineOperationMeta | undefined

/**
 * Build an app guarded by `csrf`. An upstream test middleware simulates the
 * `authenticate` phase by setting `c.set('session', ...)` when `session` is given.
 */
function buildApp(
  config: CsrfPipelineConfig,
  resolve: Resolve,
  session: SessionRecord | undefined,
) {
  const app = new Hono<SecurityEnv>()
  app.use('*', async (c, next) => {
    if (session) c.set('session', session)
    await next()
  })
  app.use('*', csrf(config, resolve))
  app.all('*', (c) => c.json({ ok: true }))
  return app
}

const RESOLVE_WRITE: Resolve = () => op(false)
const RESOLVE_READONLY: Resolve = () => op(true)

describe('csrf (S8) — cookie-authed enforcement', () => {
  it('rejects a cookie-authed POST with NO token → 403 CsrfFailed', async () => {
    const app = buildApp(makeConfig(), RESOLVE_WRITE, makeSession())
    const res = await app.request('/x', { method: 'POST' })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ code: 'CsrfFailed' })
  })

  it('rejects a cookie-authed POST with the WRONG token → 403', async () => {
    const app = buildApp(makeConfig(), RESOLVE_WRITE, makeSession())
    const res = await app.request('/x', {
      method: 'POST',
      headers: { 'X-CSRF-Token': 'not-the-right-token' },
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ code: 'CsrfFailed' })
  })

  it('passes a cookie-authed POST with the CORRECT token', async () => {
    const app = buildApp(makeConfig(), RESOLVE_WRITE, makeSession())
    const res = await app.request('/x', {
      method: 'POST',
      headers: { 'X-CSRF-Token': CSRF_TOKEN },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('honors a custom csrfHeaderName', async () => {
    const app = buildApp(
      makeConfig({ csrfHeaderName: 'X-My-Csrf' }),
      RESOLVE_WRITE,
      makeSession(),
    )

    // Wrong header name → token not found → 403.
    const miss = await app.request('/x', {
      method: 'POST',
      headers: { 'X-CSRF-Token': CSRF_TOKEN },
    })
    expect(miss.status).toBe(403)

    // Correct custom header → passes.
    const hit = await app.request('/x', {
      method: 'POST',
      headers: { 'X-My-Csrf': CSRF_TOKEN },
    })
    expect(hit.status).toBe(200)
  })
})

describe('csrf (S8) — exemptions', () => {
  it('exempts a @readonly op (passes without a token)', async () => {
    const app = buildApp(makeConfig(), RESOLVE_READONLY, makeSession())
    const res = await app.request('/x', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('exempts a request with no session (S2S/bearer) without a token', async () => {
    const app = buildApp(makeConfig(), RESOLVE_WRITE, undefined)
    const res = await app.request('/x', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('csrf (S8) — CSRF-06 Origin / Sec-Fetch-Site secondary check', () => {
  // Defense-in-depth ON TOP of the token. A provably cross-site request is
  // rejected up-front; an allowed-origin / absent-header request is unchanged
  // (the token still gates).

  it('rejects a cross-site Origin even with the CORRECT token → 403', async () => {
    const app = buildApp(makeConfig(), RESOLVE_WRITE, makeSession())
    const res = await app.request('/x', {
      method: 'POST',
      headers: { 'X-CSRF-Token': CSRF_TOKEN, Origin: 'https://evil.example.com' },
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ code: 'CsrfFailed' })
  })

  it('rejects Sec-Fetch-Site: cross-site even with the CORRECT token → 403', async () => {
    const app = buildApp(makeConfig(), RESOLVE_WRITE, makeSession())
    const res = await app.request('/x', {
      method: 'POST',
      headers: { 'X-CSRF-Token': CSRF_TOKEN, 'Sec-Fetch-Site': 'cross-site' },
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ code: 'CsrfFailed' })
  })

  it('rejects an opaque Origin: null even with the CORRECT token → 403', async () => {
    const app = buildApp(makeConfig(), RESOLVE_WRITE, makeSession())
    const res = await app.request('/x', {
      method: 'POST',
      headers: { 'X-CSRF-Token': CSRF_TOKEN, Origin: 'null' },
    })

    expect(res.status).toBe(403)
  })

  it('passes an allowed (same-origin) Origin WITH the correct token', async () => {
    const app = buildApp(makeConfig(), RESOLVE_WRITE, makeSession())
    const res = await app.request('/x', {
      method: 'POST',
      headers: {
        'X-CSRF-Token': CSRF_TOKEN,
        Origin: 'https://app.example.com',
      },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('still REQUIRES the token for an allowed-origin request (token stays primary)', async () => {
    const app = buildApp(makeConfig(), RESOLVE_WRITE, makeSession())
    const res = await app.request('/x', {
      method: 'POST',
      headers: { Origin: 'https://app.example.com' },
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ code: 'CsrfFailed' })
  })

  it('passes Sec-Fetch-Site: same-origin WITH the correct token', async () => {
    const app = buildApp(makeConfig(), RESOLVE_WRITE, makeSession())
    const res = await app.request('/x', {
      method: 'POST',
      headers: { 'X-CSRF-Token': CSRF_TOKEN, 'Sec-Fetch-Site': 'same-origin' },
    })

    expect(res.status).toBe(200)
  })

  it('does NOT 403 a same-origin request whose Origin is not in the allowlist when Sec-Fetch-Site is absent (finding csrf cross-site false-positive)', async () => {
    // Same-origin SPA+API deploy: self origin (http://localhost in the test
    // harness) is legitimately NOT in config.allowedOrigins, and an older
    // Safari / stripping proxy omits Sec-Fetch-Site. A valid synchronizer token
    // must still pass — the request is same-origin, not cross-site.
    const app = buildApp(makeConfig(), RESOLVE_WRITE, makeSession())
    const res = await app.request('http://localhost/x', {
      method: 'POST',
      headers: { 'X-CSRF-Token': CSRF_TOKEN, Origin: 'http://localhost' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('still rejects a genuinely foreign Origin (not self, not allowlisted) with no Sec-Fetch-Site', async () => {
    const app = buildApp(makeConfig(), RESOLVE_WRITE, makeSession())
    const res = await app.request('http://localhost/x', {
      method: 'POST',
      headers: { 'X-CSRF-Token': CSRF_TOKEN, Origin: 'https://evil.example.com' },
    })
    expect(res.status).toBe(403)
  })

  it('leaves behavior unchanged when neither header is present (token still passes)', async () => {
    const app = buildApp(makeConfig(), RESOLVE_WRITE, makeSession())
    const res = await app.request('/x', {
      method: 'POST',
      headers: { 'X-CSRF-Token': CSRF_TOKEN },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('csrf (S8) — empty-token floor (RT-09)', () => {
  // `timingSafeEqual('', '')` is `true`, so an empty STORED csrfToken (malformed
  // session, or a custom SessionStore that drops the field) must NOT validate
  // against an absent/empty header. Each of these must yield 403.

  it('rejects when the stored csrfToken is empty AND the attacker sends NO token → 403', async () => {
    const app = buildApp(makeConfig(), RESOLVE_WRITE, makeSession(''))
    const res = await app.request('/x', { method: 'POST' })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ code: 'CsrfFailed' })
  })

  it('rejects when the stored csrfToken is empty AND the attacker sends an EMPTY token → 403', async () => {
    const app = buildApp(makeConfig(), RESOLVE_WRITE, makeSession(''))
    const res = await app.request('/x', {
      method: 'POST',
      headers: { 'X-CSRF-Token': '' },
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ code: 'CsrfFailed' })
  })

  it('rejects when the stored csrfToken is empty even if the attacker sends a NON-empty token → 403', async () => {
    const app = buildApp(makeConfig(), RESOLVE_WRITE, makeSession(''))
    const res = await app.request('/x', {
      method: 'POST',
      headers: { 'X-CSRF-Token': 'anything' },
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ code: 'CsrfFailed' })
  })

  it('rejects when the stored token is non-empty but the provided token is empty → 403', async () => {
    const app = buildApp(makeConfig(), RESOLVE_WRITE, makeSession())
    const res = await app.request('/x', {
      method: 'POST',
      headers: { 'X-CSRF-Token': '' },
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ code: 'CsrfFailed' })
  })
})
