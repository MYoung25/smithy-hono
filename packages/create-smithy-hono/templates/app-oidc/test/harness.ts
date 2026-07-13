/**
 * Test harness — builds the SAME `createApp` the real deployment uses, but with:
 *   - in-memory stores (no external service → runs in CI),
 *   - a FAKE OIDC issuer: an injected `OidcVerifier` that returns branded claims
 *     (so no real IdP / network is needed),
 *   - a seeded S2S signing key the tests can sign against.
 */

import {
  MemorySessionStore,
  MemoryNonceStore,
  MemorySecretProvider,
  importHmacKey,
  issueSession,
  toAuthConfig,
  type Logger,
  type AuditSink,
  type OidcVerifier,
  type VerifiedClaims,
  type Principal,
} from '@smithy-hono/security-core'
import { createApp } from '../src/createApp'
import { createMemoryNotesStore, type NotesStore } from '../src/notesStore'

// A no-op logger keeps test output clean.
const silentLogger: Logger = { info() {}, warn() {}, error() {} }
const silentAudit: AuditSink = { emit: async () => {} }

// ── Fake OIDC issuer ──────────────────────────────────────────────────────────

export const FAKE_ISSUER = 'https://idp.test'
export const FAKE_CLIENT_ID = 'app-test'

/**
 * Build a fake {@link OidcVerifier}: it ignores the token bytes and returns the
 * claims it was constructed with, branded as VerifiedClaims (the test-fake path —
 * a real verifier checks the IdP signature/iss/aud/nonce).
 */
export function fakeVerifier(claims: Record<string, unknown>): OidcVerifier {
  return {
    async verify(_idToken, options) {
      const merged: Record<string, unknown> = {
        iss: FAKE_ISSUER,
        aud: FAKE_CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        ...claims,
      }
      if (options?.nonce !== undefined) merged.nonce = options.nonce
      return merged as unknown as VerifiedClaims
    },
  }
}

// ── S2S key the tests sign against ────────────────────────────────────────────

export const S2S_KEY_ID = 'importer-v1'
export const S2S_CLIENT_ID = 'importer'
export const S2S_SECRET = 'e2e-shared-secret-0123456789abcdef0123456789'

export interface Harness {
  app: ReturnType<typeof createApp>['app']
  sessions: MemorySessionStore
  nonces: MemoryNonceStore
  secrets: MemorySecretProvider
  notesStore: NotesStore
  signKey: CryptoKey
}

export async function makeHarness(overrides?: {
  verifierClaims?: Record<string, unknown>
  /** Mount the whole service (probes, auth helpers, notes) under this prefix, e.g. '/api'. */
  basePath?: string
}): Promise<Harness> {
  const sessions = new MemorySessionStore()
  const nonces = new MemoryNonceStore()
  const secrets = new MemorySecretProvider()
  const notesStore = createMemoryNotesStore()

  // Seed the S2S signing key (in prod the key tool provisions it into the durable
  // store; here the in-memory provider stands in).
  const signKey = await importHmacKey(S2S_SECRET, ['sign', 'verify'])
  secrets.addKey(S2S_KEY_ID, signKey, { clientId: S2S_CLIENT_ID, current: true })

  const { app } = createApp({
    notesStore,
    stores: { session: sessions, nonce: nonces, secrets },
    oidcVerifier: fakeVerifier(overrides?.verifierClaims ?? { sub: 'user-1' }),
    logger: silentLogger,
    audit: silentAudit,
    auditSalt: 'test-audit-salt-fixed-for-app-tests',
    oidc: {
      issuer: FAKE_ISSUER,
      clientId: FAKE_CLIENT_ID,
      audience: FAKE_CLIENT_ID,
      redirectUri: 'https://app.test/auth/callback',
      authorizationEndpoint: `${FAKE_ISSUER}/authorize`,
      tokenEndpoint: `${FAKE_ISSUER}/token`,
    },
    oidcStateSecret: 'test-state-secret-high-entropy-please',
    // The harness drives Hono's in-memory client over plaintext, so it opts into
    // trusting the X-Forwarded-Proto: https header the tests send (assertHttps then
    // passes). Production defaults this OFF (fail closed) — see src/config.ts.
    trustProxyHeaders: true,
    allowedOrigins: ['https://app.test'],
    basePath: overrides?.basePath,
  })

  return { app, sessions, nonces, secrets, notesStore, signKey }
}

// ── Session seeding (the session-authed path) ─────────────────────────────────

export interface SeededSession {
  sessionId: string
  csrfToken: string
}

/** Mint a real session via issueSession on the SAME store the app reads. */
export async function seedSession(
  store: MemorySessionStore,
  principal: Principal,
): Promise<SeededSession> {
  const issued = await issueSession(
    store,
    principal,
    toAuthConfig({
      idleTtlSeconds: 900,
      session: { absoluteTtlSeconds: 8 * 60 * 60, sameSite: 'Lax' },
    }),
  )
  return { sessionId: issued.sessionId, csrfToken: issued.csrfToken }
}

export const HTTPS = { 'x-forwarded-proto': 'https' } as const
