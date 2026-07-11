/**
 * Tests for the DEV entry's no-IdP fallback (src/devServer.ts) — deliverable 2.
 *
 * src/devServer.ts boots an HTTP server as an import side effect, so we cannot
 * import it directly here. Instead we assert the BEHAVIOUR it relies on: that
 * `createSecureApp` — wired with the SAME placeholder OIDC config + fake verifier
 * the dev entry falls back to when `OIDC_*` env is absent — constructs cleanly,
 * passes validateConfig, and serves the cookie-authed + auth-helper routes. This
 * is exactly the surface the secure-ui SPA drives in offline dev.
 *
 * These tests are purely additive and use in-memory stores (no Redis, no IdP).
 */

import { describe, it, expect } from 'vitest'
import {
  MemorySessionStore,
  MemoryNonceStore,
  MemorySecretProvider,
  type OidcVerifier,
  type VerifiedClaims,
} from '@smithy-hono/security-core'
import { createSecureApp } from '../src/createApp'
import { createMemoryNotesStore } from '../src/notesStore'
import { seedSession, HTTPS } from './harness'

const COOKIE_NAME = '__Host-session'

/** Mirror of devServer.ts's fake fallback verifier. */
function fakeDevVerifier(): OidcVerifier {
  return {
    async verify(_idToken, options) {
      const claims: Record<string, unknown> = {
        sub: 'dev-user',
        iss: 'https://idp.invalid',
        aud: 'secure-api-dev',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
      }
      if (options?.nonce !== undefined) claims.nonce = options.nonce
      return claims as unknown as VerifiedClaims
    },
  }
}

/** Build the app with the dev entry's PLACEHOLDER (no-IdP) OIDC config. */
function makeDevFallbackApp() {
  const sessions = new MemorySessionStore()
  const { app } = createSecureApp({
    notesStore: createMemoryNotesStore(),
    stores: {
      session: sessions,
      nonce: new MemoryNonceStore(),
      secrets: new MemorySecretProvider(),
    },
    oidcVerifier: fakeDevVerifier(),
    logger: { info() {}, warn() {}, error() {} },
    audit: { emit: async () => {} },
    auditSalt: 'dev-salt-not-for-production-replace-me',
    oidc: {
      issuer: 'https://idp.invalid',
      clientId: 'secure-api-dev',
      audience: 'secure-api-dev',
      redirectUri: 'http://localhost:5173/auth/callback',
      authorizationEndpoint: 'https://idp.invalid/authorize',
      tokenEndpoint: 'https://idp.invalid/token',
    },
    oidcStateSecret: 'dev-state-secret-high-entropy-please-change',
    allowedOrigins: ['http://localhost:5173'],
    trustProxyHeaders: true,
  })
  return { app, sessions }
}

describe('dev entry no-IdP fallback config', () => {
  it('constructs cleanly with placeholder OIDC config (validateConfig passes)', () => {
    expect(() => makeDevFallbackApp()).not.toThrow()
  })

  it('GET /auth/login still 302-redirects to the placeholder authorize endpoint', async () => {
    const { app } = makeDevFallbackApp()
    const res = await app.request('/auth/login', { headers: { ...HTTPS } })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location') ?? '').toContain('https://idp.invalid/authorize')
  })

  it('a seeded session can drive a CSRF-guarded create + read via the dev app', async () => {
    const { app, sessions } = makeDevFallbackApp()
    const { sessionId, csrfToken } = await seedSession(sessions, {
      id: 'dev-user',
      permissions: ['notes.read', 'notes.write'],
      claims: {},
      kind: 'user',
    })
    const created = await app.request('/notes', {
      method: 'POST',
      headers: {
        ...HTTPS,
        'Content-Type': 'application/json',
        Cookie: `${COOKIE_NAME}=${sessionId}`,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ title: 'dev note' }),
    })
    expect(created.status).toBe(201)
    const id = ((await created.json()) as { item: { id: string } }).item.id

    const list = await app.request('/notes', {
      headers: { ...HTTPS, Cookie: `${COOKIE_NAME}=${sessionId}` },
    })
    expect(list.status).toBe(200)
    const items = ((await list.json()) as { items: { id: string }[] }).items
    expect(items.map((n) => n.id)).toContain(id)
  })

  it('GET /csrf-token returns the seeded session token (the route the SPA refresh() hits)', async () => {
    const { app, sessions } = makeDevFallbackApp()
    const { sessionId, csrfToken } = await seedSession(sessions, {
      id: 'dev-user',
      permissions: ['notes.read', 'notes.write'],
      claims: {},
      kind: 'user',
    })
    const res = await app.request('/csrf-token', {
      headers: { ...HTTPS, Cookie: `${COOKIE_NAME}=${sessionId}` },
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { csrfToken: string }).csrfToken).toBe(csrfToken)
  })
})
