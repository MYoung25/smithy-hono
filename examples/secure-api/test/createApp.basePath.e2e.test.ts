/**
 * Base-path mount e2e — the full-stack Cloudflare deploy topology mounts the WHOLE
 * service (probes + OIDC auth helpers + the generated note router) under `/api`.
 *
 * This guards the critical correctness property of that wiring: when routes are
 * prefixed, the security pipeline's per-operation auth MUST still be enforced. The
 * trap (see createApp.ts / `withBasePath`) is that the pipeline resolves each op
 * from the FULL request path — a mis-wired prefix that fails to prefix the registry
 * would resolve no op for `/api/notes` and SILENTLY skip per-op auth (return 2xx
 * instead of 401). Assertion (2) below fails loudly if that regresses.
 *
 * Reuses the existing in-memory-store + fake-OIDC-issuer harness verbatim (the only
 * delta is `basePath: '/api'`), and mirrors security-e2e.test.ts's exact cookie /
 * CSRF / fake-issuer mechanics for the happy path.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { makeHarness, HTTPS, FAKE_ISSUER } from './harness'

const COOKIE_NAME = '__Host-session'
const BASE = '/api'

describe('service mounted under a /api base path', () => {
  afterEach(() => vi.unstubAllGlobals())

  // (1) Prefixed liveness probe is reachable AND survives assertHttps (the harness
  //     sends X-Forwarded-Proto: https + opts into trustProxyHeaders).
  it('GET /api/healthz → 200', async () => {
    const { app } = await makeHarness({ basePath: BASE })
    const res = await app.request(`${BASE}/healthz`, { headers: { ...HTTPS } })
    expect(res.status).toBe(200)
  })

  // (2) THE CORE GUARD: the prefixed registry still enforces per-op OIDC auth. A
  //     2xx here means the prefix wiring silently disabled auth — that MUST fail.
  it('GET /api/notes with NO session cookie → 401 (per-op auth still enforced under prefix)', async () => {
    const { app } = await makeHarness({ basePath: BASE })
    const res = await app.request(`${BASE}/notes`, { headers: { ...HTTPS } })
    expect(res.status).toBe(401)
  })

  // (3) Full happy path under /api: login → callback (fake issuer) → csrf-token →
  //     POST /api/notes → GET /api/notes, with cookie + CSRF threaded throughout.
  it('full OIDC + CRUD happy path, all under /api', async () => {
    const { app, sessions } = await makeHarness({
      basePath: BASE,
      verifierClaims: { sub: 'oidc-user' },
    })

    // login → 302 to the IdP authorize endpoint; sets the per-tx cookie.
    const login = await app.request(`${BASE}/auth/login`, { headers: { ...HTTPS } })
    expect(login.status).toBe(302)
    const location = login.headers.get('Location') ?? ''
    expect(location).toContain(`${FAKE_ISSUER}/authorize`)
    const state = new URL(location).searchParams.get('state')!
    expect(state).toBeTruthy()
    const txCookie = (login.headers.get('Set-Cookie') ?? '').split(';')[0]
    expect(txCookie).toContain('__Host-oidc-tx-')

    // Stub the IdP token endpoint (code → tokens). The injected fake verifier
    // ignores the bytes, so any non-empty id_token suffices.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ id_token: 'fake.jwt.token', token_type: 'Bearer' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )

    // callback with the matching state + tx cookie → 200, CSRF in body.
    const callback = await app.request(
      `${BASE}/auth/callback?code=auth-code&state=${encodeURIComponent(state)}`,
      { headers: { ...HTTPS, Cookie: txCookie } },
    )
    expect(callback.status).toBe(200)
    const cb = (await callback.json()) as { ok: boolean; csrfToken: string }
    expect(cb.ok).toBe(true)

    // Pick the __Host-session cookie out of the (multi) Set-Cookie list.
    const sessionSetCookie =
      callback.headers.getSetCookie().find((sc) => sc.startsWith(`${COOKIE_NAME}=`)) ?? ''
    const sessionCookie = sessionSetCookie.split(';')[0]
    expect(sessionCookie).toContain(`${COOKIE_NAME}=`)
    const sid = sessionCookie.slice(`${COOKIE_NAME}=`.length)
    expect((await sessions.get(sid))?.principal.id).toBe('oidc-user')

    // GET /api/csrf-token → 200, returns the session's CSRF token.
    const csrf = await app.request(`${BASE}/csrf-token`, {
      headers: { ...HTTPS, Cookie: sessionCookie },
    })
    expect(csrf.status).toBe(200)
    const csrfToken = ((await csrf.json()) as { csrfToken: string }).csrfToken
    expect(csrfToken).toBe(cb.csrfToken)

    // POST /api/notes (cookie + CSRF) → 201, owned by the caller.
    const create = await app.request(`${BASE}/notes`, {
      method: 'POST',
      headers: {
        ...HTTPS,
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ title: 'under /api', body: 'hello' }),
    })
    expect(create.status).toBe(201)
    const created = (await create.json()) as { item: { id: string; ownerId: string } }
    expect(created.item.ownerId).toBe('oidc-user')

    // GET /api/notes → lists the created note.
    const list = await app.request(`${BASE}/notes`, {
      headers: { ...HTTPS, Cookie: sessionCookie },
    })
    expect(list.status).toBe(200)
    const listed = (await list.json()) as { items: Array<{ id: string }> }
    expect(listed.items.some((n) => n.id === created.item.id)).toBe(true)
  })

  // (4) Nothing is served at the root when mounted under /api.
  it('GET /notes (UNPREFIXED) → 404 (nothing served at root)', async () => {
    const { app } = await makeHarness({ basePath: BASE })
    const res = await app.request('/notes', { headers: { ...HTTPS } })
    expect(res.status).toBe(404)
  })
})
