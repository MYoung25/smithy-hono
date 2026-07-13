/**
 * Test harness for the secure example — builds the SAME `createSecureApp` the
 * real deployment uses, but with:
 *   - in-memory stores (no Redis required → runs in CI),
 *   - a FAKE OIDC issuer: an injected `OidcVerifier` that returns branded claims,
 *     plus a stubbed token endpoint (so no real IdP / network / jose-env hazard),
 *   - a seeded S2S signing key the tests sign against.
 *
 * This mirrors how todo-api's security-e2e.test.ts builds its own richly-configured
 * pipeline and fakes identity where a real IdP isn't available.
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
  type AuditEvent,
  type OidcVerifier,
  type VerifiedClaims,
  type Principal,
} from '@smithy-hono/security-core'
import { createSecureApp } from '../src/createApp'
import { createMemoryNotesStore, type NotesStore } from '../src/notesStore'

// A no-op logger keeps test output clean (createStdoutSilentLogger may not exist
// in the published surface; fall back to a local silent logger).
const silentLogger: Logger = { info() {}, warn() {}, error() {} }

/** Capture audit events so a test can assert on what the pipeline emitted. */
export function recordingAuditSink(): { sink: AuditSink; events: AuditEvent[] } {
  const events: AuditEvent[] = []
  return {
    sink: {
      emit(e) {
        events.push(e)
        return Promise.resolve()
      },
    },
    events,
  }
}

// ── Fake OIDC issuer ──────────────────────────────────────────────────────────

export const FAKE_ISSUER = 'https://idp.test'
export const FAKE_CLIENT_ID = 'secure-api-test'

/**
 * Build a fake {@link OidcVerifier}: it ignores the token bytes and returns the
 * claims it was constructed with, branded as VerifiedClaims (the test-fake path —
 * a real verifier checks the IdP signature/iss/aud/nonce). `expectNonce` lets a
 * test assert the callback threaded the login nonce through (RT-03 binding).
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
  app: ReturnType<typeof createSecureApp>['app']
  sessions: MemorySessionStore
  nonces: MemoryNonceStore
  secrets: MemorySecretProvider
  notesStore: NotesStore
  signKey: CryptoKey
  auditEvents: AuditEvent[]
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
  const { sink, events } = recordingAuditSink()

  // Seed the S2S signing key (in prod the key tool provisions it into Redis;
  // here the in-memory provider stands in).
  const signKey = await importHmacKey(S2S_SECRET, ['sign', 'verify'])
  secrets.addKey(S2S_KEY_ID, signKey, { clientId: S2S_CLIENT_ID, current: true })

  const { app } = createSecureApp({
    notesStore,
    stores: { session: sessions, nonce: nonces, secrets },
    oidcVerifier: fakeVerifier(overrides?.verifierClaims ?? { sub: 'user-1' }),
    logger: silentLogger,
    audit: sink,
    auditSalt: 'test-audit-salt-fixed-for-secure-api-tests',
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

  return { app, sessions, nonces, secrets, notesStore, signKey, auditEvents: events }
}

// ── Session seeding (the session-authed path, mirrors todo-api) ───────────────

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
