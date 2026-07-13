/**
 * Node deploy entry (container) for the SECURE service: all seven security layers +
 * the OIDC cookie-session flow, served by `@hono/node-server` under `/api`. The
 * nginx front-door (rendered by `@smithy-hono/deploy-node`) proxies `/api/*` here
 * and serves the SPA for everything else, same-origin.
 *
 * Security state (sessions / nonces / signing keys) is backed by REDIS when
 * `REDIS_URL` is set — durable + shared across replicated pods. Without it, the
 * pod falls back to IN-MEMORY stores (single-replica / demo: state is per-pod and
 * lost on restart). The `notes` business data is in-memory in BOTH modes (this is a
 * security-wiring reference; swap `createMemoryNotesStore` for a durable adapter to
 * persist notes).
 *
 * Driven entirely by env (12-factor / ARCH-05). The OIDC verifier is built EAGERLY
 * at boot (a discovery `fetch` to the issuer), so the container requires the
 * `OIDC_*` facts to resolve to a REAL IdP — replace the placeholder values in
 * smithy-node-deploy.config.mjs before deploying.
 *
 *   REDIS_URL              redis://host:6379          (optional; in-memory if unset)
 *   OIDC_ISSUER            https://idp.example.com    (required)
 *   OIDC_CLIENT_ID         the registered client      (required)
 *   OIDC_CLIENT_SECRET     confidential-client secret (optional for public PKCE)
 *   OIDC_REDIRECT_URI      https://app/api/auth/callback (required)
 *   OIDC_AUTHORIZE_URL     IdP authorize endpoint     (required)
 *   OIDC_TOKEN_URL         IdP token endpoint         (required)
 *   OIDC_STATE_SECRET      HMAC secret for the login↔callback tx cookie (required)
 *   AUDIT_SALT             per-deployment pseudonymization salt (RT-12)
 *   SIGNING_KEY_IMPORTER_V1  base64 HMAC bytes for the demo S2S client key
 *   IMPORTER_CLIENT_ID     S2S client id              (default 'importer')
 *   IMPORTER_KEY_ID        its current keyId          (default 'importer-v1')
 *   TRUST_PROXY_HEADERS    "1" behind a trusted proxy that sets X-Forwarded-*
 */

import { serve } from '@hono/node-server'
import Redis from 'ioredis'
import {
  createRedisPort,
  RedisSessionStore,
  RedisNonceStore,
  NodeSecretProvider,
  envSecretSource,
  createStdoutLogger,
  createStdoutAuditSink,
  type RedisClientLike,
} from '@smithy-hono/adapter-node'
import {
  createOidcVerifier,
  MemorySessionStore,
  MemoryNonceStore,
  MemorySecretProvider,
  importHmacKey,
  type SessionStore,
  type NonceStore,
  type SecretProvider,
} from '@smithy-hono/security-core'
import { createApp } from './createApp'
import { createMemoryNotesStore } from './notesStore'

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is required for the secure deployment`)
  return v
}

const REDIS_URL = process.env.REDIS_URL
const TRUST_PROXY_HEADERS = process.env.TRUST_PROXY_HEADERS === '1'
const IMPORTER_CLIENT_ID = process.env.IMPORTER_CLIENT_ID ?? 'importer'
const IMPORTER_KEY_ID = process.env.IMPORTER_KEY_ID ?? 'importer-v1'

// ── Security stores: Redis (durable, multi-replica) or in-memory (demo) ─────────
let session: SessionStore
let nonce: NonceStore
let secrets: SecretProvider

if (REDIS_URL) {
  // Structural ioredis client → adapter-node port (no Redis SDK in the adapter).
  const redis = new Redis(REDIS_URL)
  const port = createRedisPort(redis as unknown as RedisClientLike)
  session = new RedisSessionStore(port)
  nonce = new RedisNonceStore(port)
  // S2S signing key resolved from env (SIGNING_KEY_<KEYID>, base64 material).
  secrets = new NodeSecretProvider(envSecretSource(), {
    currentKeyByClient: { [IMPORTER_CLIENT_ID]: IMPORTER_KEY_ID },
  })
} else {
  session = new MemorySessionStore()
  nonce = new MemoryNonceStore()
  // Seed the demo S2S key into an in-memory provider so validateConfig (which
  // requires a secrets provider for the signed ImportNotes op) passes.
  const mem = new MemorySecretProvider()
  const importerSecret =
    process.env.IMPORTER_SECRET ?? 'demo-importer-shared-secret-0123456789abcdef0123456789'
  mem.addKey(IMPORTER_KEY_ID, await importHmacKey(importerSecret, ['sign', 'verify']), {
    clientId: IMPORTER_CLIENT_ID,
    current: true,
  })
  secrets = mem
}

// A real remote-JWKS OIDC verifier (built once; keeps the JWKS cache warm). On a
// constrained network this hits the IdP's discovery + JWKS endpoints at boot.
const oidcVerifier = await createOidcVerifier({
  issuer: required('OIDC_ISSUER'),
  audience: required('OIDC_CLIENT_ID'),
})

const { app } = createApp({
  notesStore: createMemoryNotesStore(),
  stores: { session, nonce, secrets },
  oidcVerifier,
  logger: createStdoutLogger(),
  audit: createStdoutAuditSink({ base: { service: '{{APP_SLUG}}' } }),
  auditSalt: process.env.AUDIT_SALT ?? 'demo-salt-replace-in-production',
  oidc: {
    issuer: required('OIDC_ISSUER'),
    clientId: required('OIDC_CLIENT_ID'),
    clientSecret: process.env.OIDC_CLIENT_SECRET,
    audience: required('OIDC_CLIENT_ID'),
    redirectUri: required('OIDC_REDIRECT_URI'),
    authorizationEndpoint: required('OIDC_AUTHORIZE_URL'),
    tokenEndpoint: required('OIDC_TOKEN_URL'),
  },
  oidcStateSecret: required('OIDC_STATE_SECRET'),
  trustProxyHeaders: TRUST_PROXY_HEADERS,
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // Mount under /api; the nginx front-door serves the SPA for everything else.
  basePath: '/api',
})

const port = Number(process.env.PORT ?? 3000)
serve({ fetch: app.fetch, port }, () => {
  console.log(`Secure API (${REDIS_URL ? 'redis' : 'in-memory'} stores) running on :${port}`)
})
