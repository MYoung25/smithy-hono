/**
 * End-to-end test over the FULLY-WIRED `createApp` (the same factory the deploy
 * entries boot), through Hono's in-memory client. Runs after `npm run codegen`
 * (which emits src/generated/*), with in-memory stores + a fake OIDC verifier — no
 * external service, no IdP, CI-safe.
 *
 * Exercises:
 *   1. an unauthenticated request to a cookie op → 401,
 *   2. the full OIDC login → callback round trip (fake issuer): a session is
 *      minted + a CSRF token returned, then create → list under that session.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { makeHarness, seedSession, HTTPS, FAKE_ISSUER } from './harness'
import type { Principal } from '@smithy-hono/security-core'

const COOKIE_NAME = '__Host-session'

function userPrincipal(id: string, perms = ['notes.read', 'notes.write']): Principal {
  return { id, permissions: perms, claims: {}, kind: 'user' }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Unauthenticated → 401.
// ─────────────────────────────────────────────────────────────────────────────
describe('unauthenticated request to a cookie-auth op → 401', () => {
  it('GET /notes with no cookie → 401 { code: Unauthorized }', async () => {
    const { app } = await makeHarness()
    const res = await app.request('/notes', { headers: { ...HTTPS } })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ code: 'Unauthorized' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Session-authed create → list, with CSRF enforcement.
// ─────────────────────────────────────────────────────────────────────────────
describe('session-authed CreateNote + ListNotes', () => {
  it('cookie-authed POST WITHOUT X-CSRF-Token → 403 CsrfFailed', async () => {
    const { app, sessions } = await makeHarness()
    const { sessionId } = await seedSession(sessions, userPrincipal('u1'))
    const res = await app.request('/notes', {
      method: 'POST',
      headers: {
        ...HTTPS,
        'Content-Type': 'application/json',
        Cookie: `${COOKIE_NAME}=${sessionId}`,
      },
      body: JSON.stringify({ title: 'no csrf' }),
    })
    expect(res.status).toBe(403)
  })

  it('the SAME request WITH the CSRF token → 201, then GET /notes lists it', async () => {
    const { app, sessions } = await makeHarness()
    const { sessionId, csrfToken } = await seedSession(sessions, userPrincipal('u1'))
    const created = await app.request('/notes', {
      method: 'POST',
      headers: {
        ...HTTPS,
        'Content-Type': 'application/json',
        Cookie: `${COOKIE_NAME}=${sessionId}`,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ title: 'hello', body: 'world' }),
    })
    expect(created.status).toBe(201)
    const { item } = (await created.json()) as { item: { id: string; ownerId: string } }
    expect(item.ownerId).toBe('u1')

    const listed = await app.request('/notes', {
      headers: { ...HTTPS, Cookie: `${COOKIE_NAME}=${sessionId}` },
    })
    expect(listed.status).toBe(200)
    const page = (await listed.json()) as { items: Array<{ id: string }> }
    expect(page.items.some((n) => n.id === item.id)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. OIDC login → callback round trip against the fake issuer, then create.
// ─────────────────────────────────────────────────────────────────────────────
describe('OIDC login → callback (fake issuer) → create', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('login 302 → callback mints a session + CSRF → create is owned by the caller', async () => {
    const { app, sessions } = await makeHarness({ verifierClaims: { sub: 'oidc-user' } })

    // 1. /auth/login → 302 to the authorize endpoint, sets the signed tx cookie.
    const login = await app.request('/auth/login', { headers: { ...HTTPS } })
    expect(login.status).toBe(302)
    const location = login.headers.get('Location') ?? ''
    expect(location).toContain(`${FAKE_ISSUER}/authorize`)
    const state = new URL(location).searchParams.get('state')!
    expect(state).toBeTruthy()
    const txCookie = (login.headers.get('Set-Cookie') ?? '').split(';')[0]
    expect(txCookie).toContain('__Host-oidc-tx-')

    // 2. Stub the IdP token endpoint (code → tokens). The injected fake verifier
    //    ignores the token bytes, so any non-empty id_token suffices.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ id_token: 'fake.jwt.token', token_type: 'Bearer' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )

    // 3. /auth/callback with the matching state + tx cookie → 200, CSRF in body.
    const callback = await app.request(
      `/auth/callback?code=auth-code&state=${encodeURIComponent(state)}`,
      { headers: { ...HTTPS, Cookie: txCookie } },
    )
    expect(callback.status).toBe(200)
    const body = (await callback.json()) as { ok: boolean; csrfToken: string }
    expect(body.ok).toBe(true)

    // Pick the __Host-session cookie out of the (multi) Set-Cookie list.
    const sessionSetCookie =
      callback.headers.getSetCookie().find((sc) => sc.startsWith(`${COOKIE_NAME}=`)) ?? ''
    const sessionCookie = sessionSetCookie.split(';')[0]
    const sid = sessionCookie.slice(`${COOKIE_NAME}=`.length)
    expect((await sessions.get(sid))?.principal.id).toBe('oidc-user')

    // 4. The minted session drives a real CSRF-guarded mutation.
    const create = await app.request('/notes', {
      method: 'POST',
      headers: {
        ...HTTPS,
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
        'X-CSRF-Token': body.csrfToken,
      },
      body: JSON.stringify({ title: 'via oidc session' }),
    })
    expect(create.status).toBe(201)
    expect(((await create.json()) as { item: { ownerId: string } }).item.ownerId).toBe('oidc-user')
  })
})
