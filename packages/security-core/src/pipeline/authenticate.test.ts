import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { authenticate } from './authenticate.js'
import { MemorySessionStore } from '../storage/memory.js'
import type { SessionRecord, SessionStore } from '../storage/index.js'
import type { SecurityConfig } from '../config.js'
import type { SecurityEnv } from './context.js'
import { issueSession, type AuthConfig } from '../auth/session.js'

const COOKIE = '__Host-session'

const authOpts: AuthConfig = { absoluteTtlSeconds: 3600, idleTtlSeconds: 900 }

/** A store wrapper that records calls to `touch` for assertions. */
class TouchSpyStore implements SessionStore {
  touchCalls: Array<{ sid: string; ttl: number }> = []
  constructor(private readonly inner: SessionStore) {}
  get(sid: string) {
    return this.inner.get(sid)
  }
  set(sid: string, rec: SessionRecord, ttl: number) {
    return this.inner.set(sid, rec, ttl)
  }
  delete(sid: string) {
    return this.inner.delete(sid)
  }
  async touch(sid: string, ttl: number) {
    this.touchCalls.push({ sid, ttl })
    return this.inner.touch(sid, ttl)
  }
}

/** Minimal registry-style resolver keyed by method+path. */
type Scheme = { type: string }
function makeResolve(routes: Record<string, Scheme[]>) {
  return (method: string, path: string) => {
    const schemes = routes[`${method.toUpperCase()} ${path}`]
    return schemes ? { authSchemes: schemes } : undefined
  }
}

function makeConfig(store?: SessionStore): SecurityConfig {
  return {
    allowedOrigins: ['https://app.example.com'],
    hsts: { maxAge: 31536000, includeSubDomains: true },
    idleTtlSeconds: 900,
    stores: store ? { session: store } : {},
  }
}

/** Build a Hono app guarded by `authenticate`, exposing the resolved principal. */
function buildApp(config: SecurityConfig, resolve: ReturnType<typeof makeResolve>) {
  const app = new Hono<SecurityEnv>()
  app.use('*', authenticate(config, resolve))
  app.all('*', (c) => {
    const p = c.get('principal')
    return c.json({ ok: true, principalId: p?.id ?? null, hasSession: !!c.get('session') })
  })
  return app
}

describe('authenticate (S5) — cookie sessions', () => {
  it('401s with a uniform body when no cookie is present', async () => {
    const store = new MemorySessionStore()
    const resolve = makeResolve({ 'GET /todos/1': [{ type: 'oidc' }] })
    const app = buildApp(makeConfig(store), resolve)

    const res = await app.request('/todos/1')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ code: 'Unauthorized' })
  })

  it('resolves a valid session → sets principal + session and slides idle TTL', async () => {
    const inner = new MemorySessionStore()
    const store = new TouchSpyStore(inner)
    const issued = await issueSession(store, {
      id: 'user-42',
      permissions: ['todos.read'],
      claims: {},
      kind: 'user',
    }, authOpts)

    const resolve = makeResolve({ 'GET /todos/1': [{ type: 'oidc' }] })
    const app = buildApp(makeConfig(store), resolve)

    const res = await app.request('/todos/1', {
      headers: { Cookie: `${COOKIE}=${issued.sessionId}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, principalId: 'user-42', hasSession: true })

    // Idle TTL slid (AUTH-05) with the configured value.
    expect(store.touchCalls).toEqual([{ sid: issued.sessionId, ttl: 900 }])
  })

  it('401s on an absolute-expired session', async () => {
    const store = new MemorySessionStore()
    // Set directly with an absoluteExpiry in the past.
    const sid = 'expired-abs'
    await store.set(
      sid,
      {
        principal: { id: 'u', permissions: [], claims: {}, kind: 'user' },
        createdAt: Date.now() - 10_000,
        absoluteExpiry: Date.now() - 1, // already past
        csrfToken: 'x',
        claims: {},
      },
      900, // idle TTL still alive
    )
    const resolve = makeResolve({ 'GET /todos/1': [{ type: 'oidc' }] })
    const app = buildApp(makeConfig(store), resolve)

    const res = await app.request('/todos/1', {
      headers: { Cookie: `${COOKIE}=${sid}` },
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ code: 'Unauthorized' })
  })

  it('401s on an idle-expired session', async () => {
    const store = new MemorySessionStore()
    const sid = 'expired-idle'
    await store.set(
      sid,
      {
        principal: { id: 'u', permissions: [], claims: {}, kind: 'user' },
        createdAt: Date.now() - 10_000,
        absoluteExpiry: Date.now() + 3_600_000, // absolute still fine
        csrfToken: 'x',
        claims: {},
      },
      -1, // idle TTL already expired (expiresAt in the past)
    )
    const resolve = makeResolve({ 'GET /todos/1': [{ type: 'oidc' }] })
    const app = buildApp(makeConfig(store), resolve)

    const res = await app.request('/todos/1', {
      headers: { Cookie: `${COOKIE}=${sid}` },
    })
    expect(res.status).toBe(401)
  })
})

describe('authenticate (S5) — AUTH-SESSION-04: logout clears cookie instead of 401', () => {
  // POST /auth/logout is registered with the `oidc` scheme so CSRF guards it, so
  // `authenticate` runs first. On a missing/invalid/expired session it must clear
  // the cookie (Max-Age=0 Set-Cookie) and return 204 — honoring logout's
  // documented idempotency — rather than the uniform 401 that would leave a stale
  // cookie in place.
  const logoutRoute = { 'POST /auth/logout': [{ type: 'oidc' }] }

  function expectClearedCookie(res: Response) {
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(`${COOKIE}=`)
    expect(setCookie).toContain('Max-Age=0')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('Path=/')
  }

  it('204 + clears the cookie when no session cookie is present (no_cookie)', async () => {
    const store = new MemorySessionStore()
    const app = buildApp(makeConfig(store), makeResolve(logoutRoute))

    const res = await app.request('/auth/logout', { method: 'POST' })
    expect(res.status).toBe(204)
    expectClearedCookie(res)
  })

  it('204 + clears the cookie when the session is invalid/unknown (invalid_session)', async () => {
    const store = new MemorySessionStore()
    const app = buildApp(makeConfig(store), makeResolve(logoutRoute))

    const res = await app.request('/auth/logout', {
      method: 'POST',
      headers: { Cookie: `${COOKIE}=nonexistent-sid` },
    })
    expect(res.status).toBe(204)
    expectClearedCookie(res)
  })

  it('204 + clears the cookie when the session is absolute-expired (expired)', async () => {
    const store = new MemorySessionStore()
    const sid = 'expired-logout'
    await store.set(
      sid,
      {
        principal: { id: 'u', permissions: [], claims: {}, kind: 'user' },
        createdAt: Date.now() - 10_000,
        absoluteExpiry: Date.now() - 1, // already past
        csrfToken: 'x',
        claims: {},
      },
      900,
    )
    const app = buildApp(makeConfig(store), makeResolve(logoutRoute))

    const res = await app.request('/auth/logout', {
      method: 'POST',
      headers: { Cookie: `${COOKIE}=${sid}` },
    })
    expect(res.status).toBe(204)
    expectClearedCookie(res)
  })

  it('does NOT special-case other routes — a missing session still 401s', async () => {
    const store = new MemorySessionStore()
    // Same path but a non-logout method, and a different path: both stay 401.
    const app = buildApp(
      makeConfig(store),
      makeResolve({
        'GET /auth/logout': [{ type: 'oidc' }],
        'POST /todos/1': [{ type: 'oidc' }],
      }),
    )

    const wrongMethod = await app.request('/auth/logout', { method: 'GET' })
    expect(wrongMethod.status).toBe(401)
    const otherRoute = await app.request('/todos/1', { method: 'POST' })
    expect(otherRoute.status).toBe(401)
  })
})

describe('authenticate (S5) — bypass branches', () => {
  it('bypasses an anonymous op (AUTH-01 opt-out) — no 401', async () => {
    const store = new MemorySessionStore()
    const resolve = makeResolve({ 'GET /public': [{ type: 'anonymous' }] })
    const app = buildApp(makeConfig(store), resolve)

    const res = await app.request('/public')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, principalId: null, hasSession: false })
  })

  it('bypasses an S2S (sigv4Hmac) op — signature verify handles it (S6)', async () => {
    const store = new MemorySessionStore()
    const resolve = makeResolve({ 'POST /s2s': [{ type: 'sigv4Hmac' }] })
    const app = buildApp(makeConfig(store), resolve)

    const res = await app.request('/s2s', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, principalId: null })
  })

  it('bypasses an unknown route (no op matched) — generic guards only', async () => {
    const store = new MemorySessionStore()
    const resolve = makeResolve({}) // nothing matches
    const app = buildApp(makeConfig(store), resolve)

    const res = await app.request('/unknown')
    expect(res.status).toBe(200)
  })
})

describe('authenticate (S5) — PIPELINE-MW-03: mixed anonymous + authenticating posture', () => {
  // A SOLE `anonymous` posture is a blanket opt-out (covered above). A MIXED
  // posture (`anonymous` + `oidc`) must still resolve a valid cookie session so a
  // logged-in caller is IDENTIFIED, while an anonymous caller still passes.
  const mixed = { 'POST /mixed': [{ type: 'anonymous' }, { type: 'oidc' }] }

  it('identifies a logged-in caller on a mixed-posture op (sets principal + session)', async () => {
    const store = new MemorySessionStore()
    const issued = await issueSession(
      store,
      { id: 'user-77', permissions: [], claims: {}, kind: 'user' },
      authOpts,
    )
    const app = buildApp(makeConfig(store), makeResolve(mixed))

    const res = await app.request('/mixed', {
      method: 'POST',
      headers: { Cookie: `${COOKIE}=${issued.sessionId}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, principalId: 'user-77', hasSession: true })
  })

  it('passes an anonymous caller (no cookie) on a mixed-posture op WITHOUT a 401', async () => {
    const store = new MemorySessionStore()
    const app = buildApp(makeConfig(store), makeResolve(mixed))

    const res = await app.request('/mixed', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, principalId: null, hasSession: false })
  })

  it('passes (not 401) when a mixed-posture cookie is present but invalid', async () => {
    const store = new MemorySessionStore()
    const app = buildApp(makeConfig(store), makeResolve(mixed))

    const res = await app.request('/mixed', {
      method: 'POST',
      headers: { Cookie: `${COOKIE}=nonexistent-sid` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, principalId: null, hasSession: false })
  })
})
