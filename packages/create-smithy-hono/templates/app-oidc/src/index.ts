/**
 * Local DEV entry / harness — the backend the secure SPA (ui/) talks to.
 *
 * This is a DEV HARNESS, not the production entry. Each deploy target ships its own
 * durable entry (deploy-*/src/{worker,server,handler}.ts) that injects durable
 * security stores + a real OIDC verifier. This file instead runs with NOTHING
 * installed so `npm run dev` works out of the box:
 *
 *   - IN-MEMORY security stores (no Redis/DO/Dynamo) — sessions / nonces / signing
 *     keys live in the process, exactly like the test harness. State is lost on
 *     restart. Fine for a dev demo.
 *   - OIDC is ENV-GATED. The `createApp` factory always mounts the four auth routes
 *     (`/auth/login`, `/auth/callback`, `/auth/logout`, `/csrf-token`). What we gate
 *     is whether they point at a REAL IdP:
 *       • If the required `OIDC_*` env vars are present, we build a REAL remote-JWKS
 *         verifier + real authorize/token endpoints → a full login works.
 *       • If they are absent, we log a one-line notice and fall back to PLACEHOLDER
 *         endpoints + a fake verifier so the server still BOOTS and serves the API,
 *         the CSRF / resource-policy / S2S paths all work, and `/auth/login`
 *         redirects to the (non-existent) placeholder IdP. A full end-to-end login
 *         is not exercisable without an IdP — expected + documented.
 *
 * `basePath` is `''` here (routes at root, matching the Vite dev proxy). Run with
 * `npm run dev` (tsx watch), then start the SPA in `ui/`.
 *
 * Required `OIDC_*` env for a REAL login (all of them, or none → fake fallback):
 *   OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_REDIRECT_URI, OIDC_AUTHORIZE_URL,
 *   OIDC_TOKEN_URL, OIDC_STATE_SECRET   (OIDC_CLIENT_SECRET optional for PKCE-public)
 */

import { serve } from '@hono/node-server'
import {
  MemorySessionStore,
  MemoryNonceStore,
  MemorySecretProvider,
  importHmacKey,
  createOidcVerifier,
  type Logger,
  type AuditSink,
  type OidcVerifier,
  type VerifiedClaims,
} from '@smithy-hono/security-core'
import { createApp } from './createApp'
import { createMemoryNotesStore } from './notesStore'

// ---------------------------------------------------------------------------
// Minimal dev logger + audit sink (stdout JSON). A production deploy entry swaps
// these for its platform's structured sinks (adapter-node / adapter-cf / adapter-aws).
// ---------------------------------------------------------------------------

const devLogger: Logger = {
  info: (record) => console.log(JSON.stringify({ level: 'info', ...record })),
  warn: (record) => console.warn(JSON.stringify({ level: 'warn', ...record })),
  error: (record) => console.error(JSON.stringify({ level: 'error', ...record })),
}

const devAudit: AuditSink = {
  emit: async (event) => {
    console.log(JSON.stringify({ audit: true, ...event }))
  },
}

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
 * A fake verifier for the no-IdP dev fallback. It ignores the token bytes and
 * returns a fixed verified-claims bag. It is NEVER used when `OIDC_*` env is present
 * (then a real remote-JWKS verifier is built).
 */
function fakeDevVerifier(): OidcVerifier {
  return {
    async verify(_idToken, options) {
      const claims: Record<string, unknown> = {
        sub: process.env.OIDC_DEV_SUBJECT ?? 'dev-user',
        iss: process.env.OIDC_ISSUER ?? 'https://idp.invalid',
        aud: process.env.OIDC_CLIENT_ID ?? 'dev-client',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        // mapPermissions falls back to notes.read/write for a verified user when no
        // scope claim is present, so the SPA can read + create notes.
      }
      if (options?.nonce !== undefined) claims.nonce = options.nonce
      return claims as unknown as VerifiedClaims
    },
  }
}

const realOidc = hasRealOidcEnv()

if (realOidc) {
  console.log('[dev] OIDC_* env present → using the REAL remote-JWKS verifier.')
} else {
  console.log(
    '[dev] OIDC_* env NOT set → mounting the auth routes against PLACEHOLDER endpoints + ' +
      'a fake verifier. The server still boots and serves the API; a full IdP login is not ' +
      'exercisable without a real OIDC provider (set OIDC_* to enable it).',
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
const IMPORTER_KEY_ID = process.env.IMPORTER_KEY_ID ?? 'importer-v1'
const IMPORTER_CLIENT_ID = process.env.IMPORTER_CLIENT_ID ?? 'importer'
const importerSecret =
  process.env.IMPORTER_SECRET ?? 'dev-importer-shared-secret-0123456789abcdef0123456789'
secrets.addKey(IMPORTER_KEY_ID, await importHmacKey(importerSecret, ['sign', 'verify']), {
  clientId: IMPORTER_CLIENT_ID,
  current: true,
})

const { app } = createApp({
  notesStore: createMemoryNotesStore(),
  stores: {
    session: new MemorySessionStore(),
    nonce: new MemoryNonceStore(),
    secrets,
  },
  oidcVerifier,
  logger: devLogger,
  audit: devAudit,
  auditSalt: process.env.AUDIT_SALT ?? 'dev-salt-not-for-production-replace-me',
  oidc: {
    // Real values from env when present; coherent placeholders otherwise so
    // validateConfig (which requires issuer/clientId/stateSecret) passes and the
    // login route has a (non-existent) authorize endpoint to 302 to.
    issuer: process.env.OIDC_ISSUER ?? 'https://idp.invalid',
    clientId: process.env.OIDC_CLIENT_ID ?? 'dev-client',
    clientSecret: process.env.OIDC_CLIENT_SECRET,
    audience: process.env.OIDC_CLIENT_ID ?? 'dev-client',
    redirectUri: process.env.OIDC_REDIRECT_URI ?? 'http://localhost:5173/auth/callback',
    authorizationEndpoint: process.env.OIDC_AUTHORIZE_URL ?? 'https://idp.invalid/authorize',
    tokenEndpoint: process.env.OIDC_TOKEN_URL ?? 'https://idp.invalid/token',
  },
  oidcStateSecret: process.env.OIDC_STATE_SECRET ?? 'dev-state-secret-high-entropy-please-change',
  // Allow the SPA dev origin explicitly so a direct cross-origin call also works
  // in dev (the Vite proxy forwards same-origin otherwise).
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // The dev server runs over plaintext http://localhost; trust the proxy header so
  // assertHttps is satisfied for local dev. NEVER set this in production unless
  // actually behind a trusted TLS-terminating proxy (prod entries default it OFF).
  trustProxyHeaders: true,
  // Root-mounted in dev, matching the Vite proxy (`/auth`, `/notes`, `/csrf-token`).
  basePath: '',
})

const port = Number(process.env.PORT ?? 3000)
serve({ fetch: app.fetch, port }, () => {
  console.log(`[dev] in-memory secure API on http://localhost:${port}`)
  console.log('[dev] routes: /auth/login /auth/callback /auth/logout /csrf-token /notes')
})
