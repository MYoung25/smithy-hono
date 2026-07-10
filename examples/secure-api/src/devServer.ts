/**
 * Local DEV entry for the secure-api — the backend the `examples/secure-ui` SPA
 * talks to (deliverable 2 of the `@smithy-hono/client-web` end-to-end example).
 *
 * Unlike {@link ./index.ts} (which boots the production `src/server.ts` over
 * Redis and HARD-REQUIRES a full set of `OIDC_*` env vars + a reachable IdP), this
 * entry is built to run with NOTHING installed:
 *
 *   - IN-MEMORY security stores (no Redis) — sessions / nonces / signing keys live
 *     in the process, exactly like the test harness. Fine for a dev demo; state is
 *     lost on restart.
 *   - OIDC is ENV-GATED. The `createSecureApp` factory always mounts the four auth
 *     routes (`/auth/login`, `/auth/callback`, `/auth/logout`, `/csrf-token`) — that
 *     wiring is in `createApp.ts` and is NOT changed here. What we gate is whether
 *     they point at a REAL IdP:
 *       • If the required `OIDC_*` env vars are present, we build a REAL remote-JWKS
 *         verifier and a real authorize/token endpoint config → a full login works.
 *       • If they are absent, we log a one-line notice and fall back to PLACEHOLDER
 *         endpoints + a fake verifier so the server still BOOTS and serves the SPA,
 *         the CSRF / resource-policy / S2S paths all work, and `/auth/login`
 *         redirects to the (non-existent) placeholder IdP. A full end-to-end login
 *         is simply not exercisable without an IdP — that is expected and documented
 *         in `examples/secure-ui/README.md`.
 *
 * Run it with:  `npm run dev`  (tsx watch). Then start the SPA in `examples/secure-ui`.
 *
 * Required `OIDC_*` env for a REAL login (all of them, or none → fake fallback):
 *   OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_REDIRECT_URI, OIDC_AUTHORIZE_URL,
 *   OIDC_TOKEN_URL, OIDC_STATE_SECRET   (OIDC_CLIENT_SECRET optional for PKCE-public)
 *
 * This file is ADDITIVE: it imports the SAME `createSecureApp` factory the prod
 * entry and the e2e tests use, so the security wiring it exercises is identical.
 */

import { serve } from '@hono/node-server'
import {
  MemorySessionStore,
  MemoryNonceStore,
  MemorySecretProvider,
  importHmacKey,
  createOidcVerifier,
  type OidcVerifier,
  type VerifiedClaims,
} from '@smithy-hono/security-core'
import { createStdoutLogger, createStdoutAuditSink } from '@smithy-hono/adapter-node'
import { createSecureApp } from './createApp'
import { createMemoryNotesStore } from './notesStore'

// ---------------------------------------------------------------------------
// Env-gated OIDC configuration.
// ---------------------------------------------------------------------------

/** The env vars that, together, point the auth routes at a REAL IdP. */
const OIDC_ENV_KEYS = [
  'OIDC_ISSUER',
  'OIDC_CLIENT_ID',
  'OIDC_REDIRECT_URI',
  'OIDC_AUTHORIZE_URL',
  'OIDC_TOKEN_URL',
  'OIDC_STATE_SECRET',
] as const

/** True only when EVERY required OIDC var is present — partial config is rejected. */
function hasRealOidcEnv(): boolean {
  return OIDC_ENV_KEYS.every((k) => {
    const v = process.env[k]
    return typeof v === 'string' && v.length > 0
  })
}

/**
 * A fake verifier for the no-IdP dev fallback. It mirrors the test harness: it
 * ignores the token bytes and returns a fixed verified-claims bag. It is NEVER
 * used when `OIDC_*` env is present (then a real remote-JWKS verifier is built).
 */
function fakeDevVerifier(): OidcVerifier {
  return {
    async verify(_idToken, options) {
      const claims: Record<string, unknown> = {
        sub: process.env.OIDC_DEV_SUBJECT ?? 'dev-user',
        iss: process.env.OIDC_ISSUER ?? 'https://idp.invalid',
        aud: process.env.OIDC_CLIENT_ID ?? 'secure-api-dev',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        // The example's mapPermissions falls back to notes.read/write for a verified
        // user when no scope claim is present, so the SPA can read + create notes.
      }
      if (options?.nonce !== undefined) claims.nonce = options.nonce
      return claims as unknown as VerifiedClaims
    },
  }
}

const realOidc = hasRealOidcEnv()

if (realOidc) {
  console.log('[secure-api:dev] OIDC_* env present → using the REAL remote-JWKS verifier.')
} else {
  console.log(
    '[secure-api:dev] OIDC_* env NOT set → mounting the auth routes against PLACEHOLDER ' +
      'endpoints + a fake verifier. The server still boots and serves the SPA; a full IdP ' +
      'login is not exercisable without a real OIDC provider (set OIDC_* to enable it). ' +
      'See examples/secure-ui/README.md.',
  )
}

/** Build the verifier: real remote JWKS from env, or the fake dev fallback. */
const oidcVerifier: OidcVerifier = realOidc
  ? await createOidcVerifier({
      issuer: process.env.OIDC_ISSUER as string,
      audience: process.env.OIDC_CLIENT_ID as string,
    })
  : fakeDevVerifier()

// ---------------------------------------------------------------------------
// In-memory stores + a seeded demo S2S key (so the S2S import op is also live).
// ---------------------------------------------------------------------------

const secrets = new MemorySecretProvider()
// Seed a demo S2S signing key so POST /s2s/import has a key to verify against.
// (Optional for the SPA; included so the dev server mirrors the full surface.)
const IMPORTER_KEY_ID = process.env.IMPORTER_KEY_ID ?? 'importer-v1'
const IMPORTER_CLIENT_ID = process.env.IMPORTER_CLIENT_ID ?? 'importer'
const importerSecret =
  process.env.IMPORTER_SECRET ?? 'dev-importer-shared-secret-0123456789abcdef0123456789'
secrets.addKey(IMPORTER_KEY_ID, await importHmacKey(importerSecret, ['sign', 'verify']), {
  clientId: IMPORTER_CLIENT_ID,
  current: true,
})

const { app } = createSecureApp({
  notesStore: createMemoryNotesStore(),
  stores: {
    session: new MemorySessionStore(),
    nonce: new MemoryNonceStore(),
    secrets,
  },
  oidcVerifier,
  logger: createStdoutLogger(),
  audit: createStdoutAuditSink({ base: { service: 'secure-api-dev' } }),
  auditSalt: process.env.AUDIT_SALT ?? 'dev-salt-not-for-production-replace-me',
  oidc: {
    // Real values from env when present; coherent placeholders otherwise so
    // validateConfig (which requires issuer/clientId/stateSecret) passes and the
    // login route has a (non-existent) authorize endpoint to 302 to.
    issuer: process.env.OIDC_ISSUER ?? 'https://idp.invalid',
    clientId: process.env.OIDC_CLIENT_ID ?? 'secure-api-dev',
    clientSecret: process.env.OIDC_CLIENT_SECRET,
    audience: process.env.OIDC_CLIENT_ID ?? 'secure-api-dev',
    redirectUri: process.env.OIDC_REDIRECT_URI ?? 'http://localhost:5173/auth/callback',
    authorizationEndpoint: process.env.OIDC_AUTHORIZE_URL ?? 'https://idp.invalid/authorize',
    tokenEndpoint: process.env.OIDC_TOKEN_URL ?? 'https://idp.invalid/token',
  },
  oidcStateSecret: process.env.OIDC_STATE_SECRET ?? 'dev-state-secret-high-entropy-please-change',
  // The Vite dev proxy forwards from the SPA origin same-origin, but allow the SPA
  // dev origin explicitly so a direct cross-origin call also works in dev.
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // The dev server runs over plaintext http://localhost; trust the proxy header so
  // assertHttps is satisfied for local dev. NEVER set this in production unless
  // actually behind a trusted TLS-terminating proxy (prod defaults it OFF).
  trustProxyHeaders: true,
})

const port = Number(process.env.PORT ?? 3000)
serve({ fetch: app.fetch, port }, () => {
  console.log(`[secure-api:dev] in-memory secure API on http://localhost:${port}`)
  console.log('[secure-api:dev] routes: /auth/login /auth/callback /auth/logout /csrf-token /notes')
})

export default app
