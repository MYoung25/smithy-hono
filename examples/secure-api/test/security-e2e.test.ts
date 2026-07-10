/**
 * OPS-08 — end-to-end secured-flow test for the secure-api reference.
 *
 * Exercises the FULLY-WIRED `createSecureApp` (the same factory the Redis
 * deployment boots) through Hono's in-memory client, one security layer per block:
 *
 *   1. unauthenticated request to a cookie op            → 401
 *   2. session-authed request                            → passes
 *   3. CSRF-less state-changing cookie request           → 403; with token → 201
 *   4. resource policy (isOwner): owned → 200, other → 403, missing → 404
 *   5. S2S signing: valid → 200; tampered/bad sig → 401; stale ts → 401; replay → 401
 *   6. OIDC login → callback round trip (fake issuer): session minted, CSRF returned
 *   7. validateConfig fail-fast: an incoherent config throws at construction
 *
 * Runs with in-memory stores + a fake OIDC verifier → no Redis, no IdP, CI-safe.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { signRequest, type Principal } from '@smithy-hono/security-core'
import {
  makeHarness,
  seedSession,
  HTTPS,
  S2S_KEY_ID,
  S2S_SECRET,
  FAKE_ISSUER,
} from './harness'
import { importHmacKey } from '@smithy-hono/security-core'

const COOKIE_NAME = '__Host-session'

function userPrincipal(id: string, perms = ['notes.read', 'notes.write']): Principal {
  return { id, permissions: perms, claims: {}, kind: 'user' }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Unauthenticated → 401.
// ─────────────────────────────────────────────────────────────────────────────
describe('unauthenticated request to a cookie-auth op → 401', () => {
  it('GET /notes/:id with no cookie → 401 { code: Unauthorized }', async () => {
    const { app } = await makeHarness()
    const res = await app.request('/notes/abc', { headers: { ...HTTPS } })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ code: 'Unauthorized' })
  })

  it('POST /notes with no cookie → 401', async () => {
    const { app } = await makeHarness()
    const res = await app.request('/notes', {
      method: 'POST',
      headers: { ...HTTPS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(401)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2 + 3. Session-authed CreateNote, with CSRF enforcement.
// ─────────────────────────────────────────────────────────────────────────────
describe('session-authed CreateNote + CSRF', () => {
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
    expect(await res.json()).toEqual({ code: 'CsrfFailed' })
  })

  it('the SAME request WITH the CSRF token → 201, ownerId = caller', async () => {
    const { app, sessions } = await makeHarness()
    const { sessionId, csrfToken } = await seedSession(sessions, userPrincipal('u1'))
    const res = await app.request('/notes', {
      method: 'POST',
      headers: {
        ...HTTPS,
        'Content-Type': 'application/json',
        Cookie: `${COOKIE_NAME}=${sessionId}`,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ title: 'hello', body: 'world' }),
    })
    expect(res.status).toBe(201)
    const json = (await res.json()) as { item: { ownerId: string; title: string } }
    expect(json.item.ownerId).toBe('u1')
    expect(json.item.title).toBe('hello')
  })

  it('a principal missing notes.write → 403 AccessDenied (operation tier)', async () => {
    const { app, sessions } = await makeHarness()
    const { sessionId, csrfToken } = await seedSession(sessions, userPrincipal('u1', ['notes.read']))
    const res = await app.request('/notes', {
      method: 'POST',
      headers: {
        ...HTTPS,
        'Content-Type': 'application/json',
        Cookie: `${COOKIE_NAME}=${sessionId}`,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ title: 'denied' }),
    })
    expect(res.status).toBe(403)
    expect((await res.json() as { code: string }).code).toBe('AccessDenied')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Resource policy (isOwner) on GetNote — owned/other/missing.
// ─────────────────────────────────────────────────────────────────────────────
describe('requireResourcePolicy(isOwner) on GetNote', () => {
  async function createNote(
    app: Awaited<ReturnType<typeof makeHarness>>['app'],
    sessionId: string,
    csrfToken: string,
    title: string,
  ): Promise<string> {
    const res = await app.request('/notes', {
      method: 'POST',
      headers: {
        ...HTTPS,
        'Content-Type': 'application/json',
        Cookie: `${COOKIE_NAME}=${sessionId}`,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ title }),
    })
    expect(res.status).toBe(201)
    return ((await res.json()) as { item: { id: string } }).item.id
  }

  it('owner GETs their own note → 200', async () => {
    const h = await makeHarness()
    const owner = await seedSession(h.sessions, userPrincipal('owner'))
    const id = await createNote(h.app, owner.sessionId, owner.csrfToken, 'mine')
    const res = await h.app.request(`/notes/${id}`, {
      headers: { ...HTTPS, Cookie: `${COOKIE_NAME}=${owner.sessionId}` },
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { item: { id: string } }).item.id).toBe(id)
  })

  it("a different user GETs the note → 403 AccessDenied (resource-tier deny)", async () => {
    const h = await makeHarness()
    const owner = await seedSession(h.sessions, userPrincipal('owner'))
    const other = await seedSession(h.sessions, userPrincipal('intruder'))
    const id = await createNote(h.app, owner.sessionId, owner.csrfToken, 'mine')
    const res = await h.app.request(`/notes/${id}`, {
      headers: { ...HTTPS, Cookie: `${COOKIE_NAME}=${other.sessionId}` },
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe('AccessDenied')
  })

  it('GET a non-existent note → 404 NotFound (existence-sensitive)', async () => {
    const h = await makeHarness()
    const owner = await seedSession(h.sessions, userPrincipal('owner'))
    const res = await h.app.request('/notes/does-not-exist', {
      headers: { ...HTTPS, Cookie: `${COOKIE_NAME}=${owner.sessionId}` },
    })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { code: string }).code).toBe('NotFound')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. S2S HMAC signing on ImportNotes.
// ─────────────────────────────────────────────────────────────────────────────
describe('S2S HMAC signing on ImportNotes', () => {
  const URL = 'http://localhost/s2s/import'

  async function signed(
    signKey: CryptoKey,
    opts?: { body?: string; ts?: number },
  ): Promise<RequestInit> {
    const body = opts?.body ?? JSON.stringify({ notes: [{ ownerId: 'u9', title: 'imported' }] })
    const ts = opts?.ts ?? Math.floor(Date.now() / 1000)
    const baseHeaders: Record<string, string> = {
      Host: 'localhost',
      'Content-Type': 'application/json',
    }
    const s = await signRequest({
      method: 'POST',
      url: URL,
      headers: baseHeaders,
      body,
      keyId: S2S_KEY_ID,
      key: signKey,
      signedHeaders: ['host', 'content-type'],
      timestamp: ts,
    })
    return {
      method: 'POST',
      headers: { ...baseHeaders, ...s.headers, 'x-forwarded-proto': 'https' },
      body,
    }
  }

  it('a valid signature reaches the handler → 200, imported count', async () => {
    const { app, signKey } = await makeHarness()
    const res = await app.request(URL, await signed(signKey))
    expect(res.status).toBe(200)
    expect((await res.json()) as { imported: number }).toEqual({ imported: 1 })
  })

  it('a tampered body → 401', async () => {
    const { app, signKey } = await makeHarness()
    const init = await signed(signKey)
    init.body = JSON.stringify({ notes: [{ ownerId: 'attacker', title: 'injected' }] })
    const res = await app.request(URL, init)
    expect(res.status).toBe(401)
  })

  it('a wrong signing key → 401', async () => {
    const { app } = await makeHarness()
    const wrongKey = await importHmacKey('a-totally-different-secret-0000000000', ['sign', 'verify'])
    const res = await app.request(URL, await signed(wrongKey))
    expect(res.status).toBe(401)
  })

  it('a stale timestamp (outside the 300s window) → 401', async () => {
    const { app, signKey } = await makeHarness()
    const stale = Math.floor(Date.now() / 1000) - 301
    const res = await app.request(URL, await signed(signKey, { ts: stale }))
    expect(res.status).toBe(401)
  })

  it('replay of the same signature (non-@readonly op, nonce-tracked) → first 200, second 401', async () => {
    const { app, signKey } = await makeHarness()
    const init = await signed(signKey)
    const first = await app.request(URL, { ...init })
    expect(first.status).toBe(200)
    const second = await app.request(URL, { ...init })
    expect(second.status).toBe(401)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. OIDC login → callback round trip against the fake issuer.
// ─────────────────────────────────────────────────────────────────────────────
describe('OIDC login → callback (fake issuer)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('login redirects to the IdP; callback verifies + mints a session + returns CSRF', async () => {
    const { app, sessions } = await makeHarness({ verifierClaims: { sub: 'oidc-user' } })

    // 1. /auth/login → 302 to the authorize endpoint, sets the signed tx cookie.
    const login = await app.request('/auth/login', { headers: { ...HTTPS } })
    expect(login.status).toBe(302)
    const location = login.headers.get('Location') ?? ''
    expect(location).toContain(`${FAKE_ISSUER}/authorize`)
    const authorizeUrl = new URL(location)
    const state = authorizeUrl.searchParams.get('state')!
    expect(state).toBeTruthy()
    const txCookie = (login.headers.get('Set-Cookie') ?? '').split(';')[0]
    // The tx cookie is now per-transaction (name carries the txid) so concurrent
    // logins don't clobber each other — assert the __Host-oidc-tx- prefix.
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
    expect(typeof body.csrfToken).toBe('string')

    // The callback appends MULTIPLE Set-Cookie headers (cleared tx cookie + the new
    // session cookie); pick the __Host-session one out of the full list.
    const setCookies = callback.headers.getSetCookie()
    const sessionSetCookie = setCookies.find((sc) => sc.startsWith(`${COOKIE_NAME}=`)) ?? ''
    const sessionCookie = sessionSetCookie.split(';')[0]
    expect(sessionCookie).toContain(`${COOKIE_NAME}=`)
    const sid = sessionCookie.slice(`${COOKIE_NAME}=`.length)

    // The session is real in the store, with the returned CSRF token + mapped perms.
    const record = await sessions.get(sid)
    expect(record?.principal.id).toBe('oidc-user')
    expect(record?.csrfToken).toBe(body.csrfToken)
    expect(record?.principal.permissions).toContain('notes.write')

    // 4. The minted session can drive a real CSRF-guarded mutation.
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

  it('GET /csrf-token returns the session CSRF token for an authed caller', async () => {
    const { app, sessions } = await makeHarness()
    const s = await seedSession(sessions, userPrincipal('u1'))
    const res = await app.request('/csrf-token', {
      headers: { ...HTTPS, Cookie: `${COOKIE_NAME}=${s.sessionId}` },
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { csrfToken: string }).csrfToken).toBe(s.csrfToken)
  })

  it('GET /csrf-token without a session → 401', async () => {
    const { app } = await makeHarness()
    const res = await app.request('/csrf-token', { headers: { ...HTTPS } })
    expect(res.status).toBe(401)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. validateConfig fail-fast at construction (OPS-06).
// ─────────────────────────────────────────────────────────────────────────────
describe('validateConfig fail-fast at construction', () => {
  it('the wired app constructs cleanly (coherent config)', async () => {
    await expect(makeHarness()).resolves.toBeDefined()
  })

  it('a config dropping the nonce store throws (signed non-@readonly op needs it)', async () => {
    // Reach into createSecureApp via a deliberately broken deps object.
    const { createSecureApp } = await import('../src/createApp')
    const {
      MemorySessionStore,
      MemorySecretProvider,
    } = await import('@smithy-hono/security-core')
    const { createMemoryNotesStore } = await import('../src/notesStore')
    const { fakeVerifier } = await import('./harness')

    expect(() =>
      createSecureApp({
        notesStore: createMemoryNotesStore(),
        // @ts-expect-error intentionally omitting stores.nonce to trigger the fatal issue
        stores: { session: new MemorySessionStore(), secrets: new MemorySecretProvider() },
        oidcVerifier: fakeVerifier({ sub: 'u' }),
        logger: { info() {}, warn() {}, error() {} },
        audit: { emit: async () => {} },
        auditSalt: 'x',
        oidc: {
          issuer: 'https://idp.test',
          clientId: 'c',
          audience: 'c',
          redirectUri: 'https://app/cb',
          authorizationEndpoint: 'https://idp.test/a',
          tokenEndpoint: 'https://idp.test/t',
        },
        oidcStateSecret: 'secret',
      }),
    ).toThrow(/MISSING_NONCE_STORE|Invalid security config/)
  })
})
