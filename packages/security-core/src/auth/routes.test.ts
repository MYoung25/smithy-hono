/**
 * OIDC auth route helper tests (RT-04 + RT-05).
 *
 * Drives the full login → callback → authenticated request → csrf-token → logout
 * flow against a Hono app, with the IdP token endpoint stubbed and a local JWKS
 * verifier injected (no network). Asserts: callback verifies the ID token, mints
 * + ROTATES a session, the CSRF token is returned, and an old pre-auth id is
 * invalidated by rotation (RT-05).
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  createLocalJWKSet,
  type JWK,
  type KeyLike,
} from 'jose'
import { MemorySessionStore } from '../storage/memory.js'
import { createOidcVerifier, type OidcVerifier } from './oidc.js'
import { issueSession, type OidcSessionOptions } from './session.js'
import {
  loginHandler,
  callbackHandler,
  logoutHandler,
  csrfTokenHandler,
  type AuthRoutesConfig,
} from './routes.js'
import type { Principal, SessionRecord } from '../storage/index.js'

const ISSUER = 'https://idp.example.com'
const AUDIENCE = 'client-abc'
const ALG = 'ES256'
const KID = 'k1'
const STATE_SECRET = 'state-signing-secret-please-rotate'

let privateKey: KeyLike
let jwks: { keys: JWK[] }
let verifier: OidcVerifier

beforeAll(async () => {
  const pair = await generateKeyPair(ALG)
  privateKey = pair.privateKey
  const pub = await exportJWK(pair.publicKey)
  pub.kid = KID
  pub.alg = ALG
  jwks = { keys: [pub] }
  verifier = await createOidcVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    jwks: createLocalJWKSet(jwks),
  })
})

const sessionOpts: OidcSessionOptions = {
  absoluteTtlSeconds: 3600,
  idleTtlSeconds: 900,
}

async function signIdToken(nonce: string, sub = 'oidc-alice'): Promise<string> {
  return new SignJWT({ nonce, scope: 'todos.read todos.write' })
    .setProtectedHeader({ alg: ALG, kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey as Parameters<SignJWT['sign']>[0])
}

/**
 * Build the app + a fetch stub for the token endpoint. The stub captures the
 * latest authorize `nonce` (set during login) and signs an ID token echoing it.
 */
function buildHarness() {
  const store = new MemorySessionStore()
  // The nonce is carried in the signed tx cookie; we recover it from the authorize
  // redirect URL the login handler emits, then sign a matching ID token.
  let pendingNonce = ''

  const config: AuthRoutesConfig = {
    store,
    session: sessionOpts,
    oidc: { issuer: ISSUER, audience: AUDIENCE, jwks: createLocalJWKSet(jwks) },
    clientId: AUDIENCE,
    redirectUri: 'https://app.example.com/auth/callback',
    authorizationEndpoint: `${ISSUER}/authorize`,
    tokenEndpoint: `${ISSUER}/token`,
    scopes: ['openid', 'profile'],
    mapPermissions: (claims) => {
      const s = claims['scope']
      return typeof s === 'string' ? s.split(' ') : []
    },
    stateSecret: STATE_SECRET,
    verifier,
  }

  const app = new Hono<{ Variables: { session: SessionRecord } }>()
  app.get('/auth/login', loginHandler(config))
  app.get('/auth/callback', callbackHandler(config))
  app.post('/auth/logout', logoutHandler(config))
  // csrf-token needs a session in context; simulate `authenticate` by loading it.
  app.get('/csrf-token', async (c, next) => {
    const sid = getCookie(c, '__Host-session')
    if (sid) {
      const rec = await store.get(sid)
      if (rec) c.set('session', rec)
    }
    await next()
  }, csrfTokenHandler())

  // Stub the IdP token endpoint: return an id_token echoing the pending nonce.
  const realFetch = globalThis.fetch
  const installFetch = () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === config.tokenEndpoint && init?.method === 'POST') {
        const idToken = await signIdToken(pendingNonce)
        return new Response(JSON.stringify({ id_token: idToken, token_type: 'Bearer' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    }) as typeof fetch
  }
  const restoreFetch = () => {
    globalThis.fetch = realFetch
  }

  return {
    app,
    store,
    config,
    installFetch,
    restoreFetch,
    setPendingNonce: (n: string) => {
      pendingNonce = n
    },
  }
}

/**
 * Pull the `__Host-session` value out of a response's Set-Cookie header(s).
 * A callback emits MULTIPLE Set-Cookie lines (clear tx + set session); use
 * `getSetCookie()` to get them as an array (single `.get()` would join them).
 */
function sessionCookieValue(res: Response): string {
  const lines = res.headers.getSetCookie?.() ?? [res.headers.get('Set-Cookie') ?? '']
  for (const line of lines) {
    const first = line.split(';')[0]
    const eq = first.indexOf('=')
    if (first.slice(0, eq) === '__Host-session') return first.slice(eq + 1)
  }
  return ''
}

/** Extract the `nonce` query param from the authorize redirect Location. */
function nonceFromAuthorize(location: string): string {
  return new URL(location).searchParams.get('nonce') ?? ''
}
function stateFromAuthorize(location: string): string {
  return new URL(location).searchParams.get('state') ?? ''
}

describe('loginHandler (RT-04) — start the flow', () => {
  it('redirects to the authorize endpoint with state, nonce, PKCE', async () => {
    const h = buildHarness()
    const res = await h.app.request('/auth/login')
    expect(res.status).toBe(302)
    const loc = res.headers.get('Location')!
    const u = new URL(loc)
    expect(u.origin + u.pathname).toBe(`${ISSUER}/authorize`)
    expect(u.searchParams.get('response_type')).toBe('code')
    expect(u.searchParams.get('client_id')).toBe(AUDIENCE)
    expect(u.searchParams.get('code_challenge')).toBeTruthy()
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('state')).toBeTruthy()
    expect(u.searchParams.get('nonce')).toBeTruthy()
    // The signed, per-transaction cookie was set (`__Host-oidc-tx-<txid>`,
    // AUTH-SESSION-05).
    expect(res.headers.get('Set-Cookie')).toContain('__Host-oidc-tx-')
  })
})

describe('callbackHandler (RT-04 + RT-03) — verify + establish session', () => {
  it('verifies the ID token, establishes a session, returns the CSRF token', async () => {
    const h = buildHarness()
    h.installFetch()
    try {
      // 1. Login → capture state/nonce + the tx cookie.
      const login = await h.app.request('/auth/login')
      const loc = login.headers.get('Location')!
      const state = stateFromAuthorize(loc)
      h.setPendingNonce(nonceFromAuthorize(loc))
      const txCookie = login.headers.get('Set-Cookie')!.split(';')[0]

      // 2. Callback with the matching state + a code; send the tx cookie back.
      const cb = await h.app.request(`/auth/callback?code=abc123&state=${state}`, {
        headers: { Cookie: txCookie },
      })
      expect(cb.status).toBe(200)
      const body = (await cb.json()) as { ok: boolean; csrfToken: string }
      expect(body.ok).toBe(true)
      expect(body.csrfToken).toBeTruthy()

      // 3. A __Host-session cookie was set and resolves to the right principal.
      const sid = sessionCookieValue(cb)
      expect(sid).toBeTruthy()
      const rec = await h.store.get(sid)
      expect(rec).not.toBeNull()
      expect(rec!.principal.id).toBe('oidc-alice')
      expect(rec!.principal.permissions).toEqual(['todos.read', 'todos.write'])
      expect(rec!.csrfToken).toBe(body.csrfToken)
    } finally {
      h.restoreFetch()
    }
  })

  it('echoes a same-origin returnTo path and DROPS a backslash open-redirect (finding auth-session routes-247)', async () => {
    const runFlow = async (returnToQuery: string): Promise<{ returnTo?: string }> => {
      const h = buildHarness()
      h.installFetch()
      try {
        const login = await h.app.request(`/auth/login?returnTo=${encodeURIComponent(returnToQuery)}`)
        const loc = login.headers.get('Location')!
        const state = stateFromAuthorize(loc)
        h.setPendingNonce(nonceFromAuthorize(loc))
        const txCookie = login.headers.get('Set-Cookie')!.split(';')[0]
        const cb = await h.app.request(`/auth/callback?code=abc123&state=${state}`, {
          headers: { Cookie: txCookie },
        })
        return (await cb.json()) as { returnTo?: string }
      } finally {
        h.restoreFetch()
      }
    }

    // A legitimate same-origin path is preserved.
    expect((await runFlow('/dashboard?x=1')).returnTo).toBe('/dashboard?x=1')
    // A backslash open-redirect (`/\evil.com` → host evil.com) is rejected, not echoed.
    expect((await runFlow('/\\evil.com')).returnTo).toBeUndefined()
    // A protocol-relative `//evil.com` is rejected too.
    expect((await runFlow('//evil.com')).returnTo).toBeUndefined()
  })

  it('rejects a callback whose state does not match the tx cookie (CSRF)', async () => {
    const h = buildHarness()
    h.installFetch()
    try {
      const login = await h.app.request('/auth/login')
      h.setPendingNonce(nonceFromAuthorize(login.headers.get('Location')!))
      const txCookie = login.headers.get('Set-Cookie')!.split(';')[0]
      const cb = await h.app.request('/auth/callback?code=abc&state=WRONG', {
        headers: { Cookie: txCookie },
      })
      expect(cb.status).toBe(401)
    } finally {
      h.restoreFetch()
    }
  })

  it('completes the FIRST of two concurrent logins (AUTH-SESSION-05 no clobber)', async () => {
    const h = buildHarness()
    h.installFetch()
    try {
      // Two parallel logins (e.g. two browser tabs) — each writes its OWN signed
      // transaction cookie keyed by a per-login txid, so the second no longer
      // evicts the first.
      const login1 = await h.app.request('/auth/login')
      const loc1 = login1.headers.get('Location')!
      const state1 = stateFromAuthorize(loc1)
      const nonce1 = nonceFromAuthorize(loc1)
      const tx1 = login1.headers.get('Set-Cookie')!.split(';')[0]

      const login2 = await h.app.request('/auth/login')
      const loc2 = login2.headers.get('Location')!
      const tx2 = login2.headers.get('Set-Cookie')!.split(';')[0]

      // The two logins use distinct, per-transaction cookie names.
      const name1 = tx1.split('=')[0]
      const name2 = tx2.split('=')[0]
      expect(name1).not.toBe(name2)
      expect(name1.startsWith('__Host-oidc-tx-')).toBe(true)

      // Complete the FIRST login's callback while BOTH tx cookies are present in
      // the jar — the callback must pick login 1's cookie via its state's txid.
      h.setPendingNonce(nonce1)
      const cb = await h.app.request(`/auth/callback?code=abc123&state=${state1}`, {
        headers: { Cookie: `${tx1}; ${tx2}` },
      })
      expect(cb.status).toBe(200)
      const body = (await cb.json()) as { ok: boolean; csrfToken: string }
      expect(body.ok).toBe(true)
    } finally {
      h.restoreFetch()
    }
  })

  it('rejects a callback with no transaction cookie', async () => {
    const h = buildHarness()
    h.installFetch()
    try {
      const cb = await h.app.request('/auth/callback?code=abc&state=x')
      expect(cb.status).toBe(401)
    } finally {
      h.restoreFetch()
    }
  })

  it('ROTATES a pre-existing session id on login (RT-05 anti-fixation)', async () => {
    const h = buildHarness()
    h.installFetch()
    try {
      // Plant a pre-auth (anonymous-ish) session the attacker fixed on the victim.
      const anon: Principal = { id: 'pre', permissions: [], claims: {}, kind: 'user' }
      const pre = await issueSession(h.store, anon, sessionOpts)
      const oldSid = pre.sessionId
      expect(await h.store.get(oldSid)).not.toBeNull()

      // Drive login + callback carrying that pre-auth session cookie.
      const login = await h.app.request('/auth/login')
      const loc = login.headers.get('Location')!
      const state = stateFromAuthorize(loc)
      h.setPendingNonce(nonceFromAuthorize(loc))
      const txCookie = login.headers.get('Set-Cookie')!.split(';')[0]

      const cb = await h.app.request(`/auth/callback?code=abc&state=${state}`, {
        headers: { Cookie: `${txCookie}; __Host-session=${oldSid}` },
      })
      expect(cb.status).toBe(200)
      const newSid = sessionCookieValue(cb)

      // RT-05: the new id differs and the OLD id is now invalid (rotated away).
      expect(newSid).not.toBe(oldSid)
      expect(await h.store.get(oldSid)).toBeNull()
      const newRec = await h.store.get(newSid)
      expect(newRec!.principal.id).toBe('oidc-alice')
      // New CSRF token differs from the pre-auth one (rotation, CSRF-07).
      expect(newRec!.csrfToken).not.toBe(pre.csrfToken)
    } finally {
      h.restoreFetch()
    }
  })
})

describe('csrfTokenHandler (RT-04)', () => {
  it('returns the session CSRF token for an authenticated request', async () => {
    const h = buildHarness()
    const issued = await issueSession(
      h.store,
      { id: 'u', permissions: [], claims: {}, kind: 'user' },
      sessionOpts,
    )
    const res = await h.app.request('/csrf-token', {
      headers: { Cookie: `__Host-session=${issued.sessionId}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { csrfToken: string }
    expect(body.csrfToken).toBe(issued.csrfToken)
  })

  it('401s when there is no session', async () => {
    const h = buildHarness()
    const res = await h.app.request('/csrf-token')
    expect(res.status).toBe(401)
  })
})

describe('logoutHandler (RT-04)', () => {
  it('deletes the session and clears the cookie', async () => {
    const h = buildHarness()
    const issued = await issueSession(
      h.store,
      { id: 'u', permissions: [], claims: {}, kind: 'user' },
      sessionOpts,
    )
    expect(await h.store.get(issued.sessionId)).not.toBeNull()

    const res = await h.app.request('/auth/logout', {
      method: 'POST',
      headers: { Cookie: `__Host-session=${issued.sessionId}` },
    })
    expect(res.status).toBe(204)
    // Server-side session revoked.
    expect(await h.store.get(issued.sessionId)).toBeNull()
    // Cookie cleared (Max-Age=0).
    const setCookie = res.headers.get('Set-Cookie')!
    expect(setCookie).toContain('__Host-session=')
    expect(setCookie).toContain('Max-Age=0')
  })

  it('is idempotent with no session (still 204)', async () => {
    const h = buildHarness()
    const res = await h.app.request('/auth/logout', { method: 'POST' })
    expect(res.status).toBe(204)
  })
})
