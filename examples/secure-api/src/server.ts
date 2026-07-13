/**
 * Redis-backed secure deployment (the entry the container runs via src/index.ts).
 *
 * Wires the REAL adapter (`@smithy-hono/adapter-node` over Redis) into the secure
 * app factory, driven entirely by env (12-factor / ARCH-05):
 *
 *   REDIS_URL              redis://host:6379       (required)
 *   OIDC_ISSUER            https://idp.example.com (required)
 *   OIDC_CLIENT_ID         the registered client   (required)
 *   OIDC_CLIENT_SECRET     confidential-client secret (optional for public PKCE)
 *   OIDC_REDIRECT_URI      https://app/auth/callback (required)
 *   OIDC_AUTHORIZE_URL     IdP authorize endpoint  (required)
 *   OIDC_TOKEN_URL         IdP token endpoint      (required)
 *   OIDC_STATE_SECRET      HMAC secret for the login↔callback tx cookie (required)
 *   AUDIT_SALT             per-deployment pseudonymization salt (RT-12)
 *   SIGNING_KEY_<KEYID>    base64 raw HMAC bytes for an S2S client key
 *   IMPORTER_CLIENT_ID     S2S client id              (default 'importer')
 *   IMPORTER_KEY_ID        its current keyId          (default 'importer-v1')
 *   TRUST_PROXY_HEADERS    "1" behind a trusted proxy that sets X-Forwarded-*
 *
 * Seed the S2S key with the OPS-03 key tool (writes material into the same Redis):
 *   REDIS_URL=… npx key-tool provision importer   # prints { keyId, material }
 * then either set SIGNING_KEY_<keyId> from that material (env source, below) OR
 * swap `envSecretSource()` for `redisSecretSource(port)` to read the key tool's
 * Redis material directly. See README.md "Seeding S2S keys".
 */

import {
  createRedisPort,
  RedisSessionStore,
  RedisNonceStore,
  NodeSecretProvider,
  envSecretSource,
  createStdoutAuditSink,
  createStdoutLogger,
  type RedisClientLike,
} from '@smithy-hono/adapter-node'
import { createOidcVerifier } from '@smithy-hono/security-core'
import Redis from 'ioredis'
import { createSecureApp } from './createApp'
import { createMemoryNotesStore } from './notesStore'

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is required for the secure deployment`)
  return v
}

const REDIS_URL = required('REDIS_URL')
const TRUST_PROXY_HEADERS = process.env.TRUST_PROXY_HEADERS === '1'

const IMPORTER_CLIENT_ID = process.env.IMPORTER_CLIENT_ID ?? 'importer'
const IMPORTER_KEY_ID = process.env.IMPORTER_KEY_ID ?? 'importer-v1'

// Structural ioredis client → adapter-node port (no Redis SDK in the adapter).
const redis = new Redis(REDIS_URL)
const port = createRedisPort(redis as unknown as RedisClientLike)

// A real remote-JWKS OIDC verifier (built once; keeps the JWKS cache warm). On a
// constrained network this hits the IdP's discovery + JWKS endpoints at boot.
const oidcVerifier = await createOidcVerifier({
  issuer: required('OIDC_ISSUER'),
  audience: required('OIDC_CLIENT_ID'),
})

const { app } = createSecureApp({
  notesStore: createMemoryNotesStore(),
  stores: {
    // Redis-backed security state — shared across replicated pods.
    session: new RedisSessionStore(port),
    nonce: new RedisNonceStore(port),
    // S2S signing key resolved from the injected env source (SIGNING_KEY_<KEYID>).
    secrets: new NodeSecretProvider(envSecretSource(), {
      currentKeyByClient: { [IMPORTER_CLIENT_ID]: IMPORTER_KEY_ID },
    }),
  },
  oidcVerifier,
  logger: createStdoutLogger(),
  audit: createStdoutAuditSink({ base: { service: 'secure-api' } }),
  auditSalt: process.env.AUDIT_SALT ?? 'example-dev-salt-replace-in-production',
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
})

export default app
