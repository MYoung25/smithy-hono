/**
 * Redis-backed deployment variant of {@link ./server}.
 *
 * Identical security posture to the in-memory `server.ts`, but the three
 * stores the pipeline requires (session / secrets / nonce) are backed by
 * `@smithy-hono/adapter-node` over Redis instead of the dev in-memory ones.
 * This is the entry the k8s image runs (see `deploy/node/`): it provisions a
 * real Redis backend so session/nonce state survives across the (replicated)
 * pods.
 *
 * Wiring is driven entirely by env (12-factor / ARCH-05):
 *   REDIS_URL            redis://host:6379         (required)
 *   SIGNING_KEY_DEMO_V1  base64 raw HMAC bytes     (the demo client's key)
 *   TRUST_PROXY_HEADERS  "1" when behind Envoy Gateway (sets X-Forwarded-*)
 */

import { Hono } from 'hono'
import {
  createSecurityPipeline,
  validateConfig,
  healthHandler,
  readinessHandler,
  type PipelineConfig,
  type SecurityEnv,
} from '@smithy-hono/security-core'
import {
  createRedisPort,
  RedisSessionStore,
  RedisNonceStore,
  NodeSecretProvider,
  envSecretSource,
  type RedisClientLike,
} from '@smithy-hono/adapter-node'
import Redis from 'ioredis'
import { createTodoRouter } from '../generated/todo.gen'
import { OPERATIONS } from '../generated/registry.gen'
import { todoOps } from './implementation'

// Behind Envoy Gateway the X-Forwarded-* headers are set by a trusted proxy, so
// the deployment opts in (see the TRUSTED-HOP BOUNDARY note in server.ts). Off by
// default → fail closed (plaintext rejected, all callers share one rate bucket).
const TRUST_PROXY_HEADERS = process.env.TRUST_PROXY_HEADERS === '1'

const REDIS_URL = process.env.REDIS_URL
if (!REDIS_URL) {
  throw new Error('REDIS_URL is required for the Redis-backed deployment')
}

// Structural Redis client (ioredis) → adapter-node port. No Redis SDK is imported
// by the adapter itself (ARCH-01); the consumer (this entry) supplies the client.
// The cast bridges ioredis's overloaded `set` signature to the port's narrow
// structural `RedisClientLike` — type-only variance; ioredis satisfies it at
// runtime (same pattern as adapter-node's live Redis conformance test).
const redis = new Redis(REDIS_URL)
const port = createRedisPort(redis as unknown as RedisClientLike)

const securityConfig: PipelineConfig = {
  allowedOrigins: ['http://localhost:3000'],
  hsts: { maxAge: 31_536_000, includeSubDomains: true },
  idleTtlSeconds: 900,
  session: { absoluteTtlSeconds: 8 * 60 * 60, sameSite: 'Lax' },
  // Redis-backed stores (adapter-node) — session/nonce are shared across pods;
  // secrets resolve the demo client's HMAC key from the injected env source.
  stores: {
    session: new RedisSessionStore(port),
    nonce: new RedisNonceStore(port),
    secrets: new NodeSecretProvider(envSecretSource(), {
      currentKeyByClient: { 'demo-client': 'demo-v1' },
    }),
  },
  auditSalt: process.env.AUDIT_SALT ?? 'example-dev-salt-replace-in-production',
  maxInFlight: 200,
  requestTimeoutMs: 15_000,
  logger: {
    info: (r) => console.log(JSON.stringify({ level: 'info', ...r })),
    warn: (r) => console.warn(JSON.stringify({ level: 'warn', ...r })),
    error: (r) => console.error(JSON.stringify({ level: 'error', ...r })),
  },
  forwardedProtoHeader: (c) =>
    TRUST_PROXY_HEADERS ? c.req.header('x-forwarded-proto') ?? 'https' : undefined,
  maxBodyBytes: 1_048_576,
  protocolContentType: 'application/json',
  clientIp: (c) =>
    TRUST_PROXY_HEADERS
      ? c.req.header('x-forwarded-for') ?? '127.0.0.1'
      : 'untrusted-direct',
}

validateConfig(OPERATIONS, securityConfig)

const app = new Hono<SecurityEnv>()

// Probes bypass the security pipeline (registered first): /healthz = liveness,
// /readyz = readiness (pings the configured Redis-backed stores).
app.get('/healthz', healthHandler())
app.get('/readyz', readinessHandler(securityConfig))

app.use('*', ...createSecurityPipeline(OPERATIONS, securityConfig))
app.route('/', createTodoRouter(todoOps))

export default app
