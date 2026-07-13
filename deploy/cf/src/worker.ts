/**
 * Cloudflare Worker entry for a `@smithy-hono/security-core` service backed by
 * the `@smithy-hono/adapter-cf` stores (OPS-02 — cf IaC).
 *
 * This mirrors the README "Consumer wiring (Workers)" block and the in-memory /
 * Redis example entries (`examples/todo-api/src/server.ts` and
 * `server.redis.ts`): the SAME router / ops / security posture, but the three
 * backed stores (session / rate-limit / nonce) plus the secret provider come
 * from the Cloudflare adapter over Workers KV + a Durable Object.
 *
 * ARCH-01: web-standard APIs only — no `node:*` import anywhere in this file or
 * its imports. The adapter never imports a Cloudflare SDK; the bindings on `Env`
 * structurally satisfy the adapter's narrow `*Like` ports.
 *
 * The Durable Object class `SecurityDurableObject` is re-exported below so
 * `wrangler.toml`'s `[[durable_objects.bindings]] class_name` can resolve it.
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
  KvSessionStore,
  DurableRateLimitStore,
  DurableNonceStore,
  SecurityDurableObject,
  createFetchRateLimitStub,
  createFetchNonceStub,
  EnvSecretProvider,
  forwardedProtoHeader,
  clientIp,
  createConsoleLogger,
} from '@smithy-hono/adapter-cf'
import { createTodoRouter } from '../../../examples/todo-api/generated/todo.gen'
import { OPERATIONS } from '../../../examples/todo-api/generated/registry.gen'
import { todoOps } from '../../../examples/todo-api/src/implementation'

// Re-export the Durable Object class so wrangler can bind it (see wrangler.toml:
// `[[durable_objects.bindings]] class_name = "SecurityDurableObject"`).
export { SecurityDurableObject }

/**
 * The bindings this Worker reads. Each name MUST match `wrangler.toml` and the
 * adapter's structural ports:
 *   - `SESSIONS`    — a Workers KVNamespace (satisfies `KvNamespaceLike`).
 *   - `SECURITY_DO` — the Durable Object namespace for `SecurityDurableObject`
 *                     (its `.get(.idFromName(key))` stub satisfies the adapter's
 *                     `DurableObjectStubLike`).
 *   - `HMAC_KEY_2026A` — a `wrangler secret` holding the demo client's HMAC key
 *                     material as lowercase hex (see `EnvSecretProvider`).
 *
 * Typed structurally so this entry typechecks WITHOUT `@cloudflare/workers-types`
 * (a consuming Worker that installs the SDK gets the richer ambient types for
 * free; the shapes here are subsets, so they remain assignable).
 */
export interface Env {
  /** Workers KV namespace backing the SessionStore (eventual consistency OK). */
  SESSIONS: {
    get(key: string): Promise<string | null>
    put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
    delete(key: string): Promise<void>
  }
  /** Durable Object namespace backing the rate-limit + nonce stores (strong). */
  SECURITY_DO: {
    idFromName(name: string): unknown
    get(id: unknown): { fetch(request: Request): Promise<Response> }
  }
  /** Demo client's HMAC signing key, hex-encoded. Set via `wrangler secret put`. */
  HMAC_KEY_2026A: string
  /**
   * Per-deployment principal-pseudonymization salt (RT-12). Set via
   * `wrangler secret put AUDIT_SALT`. When unset the config falls back to an
   * unsalted, correlatable hash — dev only; production MUST provide this.
   */
  AUDIT_SALT?: string
  /**
   * Comma-separated browser origin allowlist (e.g.
   * `https://app.example.com,https://admin.example.com`). Falls back to the
   * localhost dev origin when unset.
   */
  ALLOWED_ORIGINS?: string
}

/**
 * Build the unified security config for one request scope. On Workers the `env`
 * (and thus the secret bindings) is only available per-request, so the stores
 * and the secret provider are constructed here rather than at module load.
 */
function buildConfig(env: Env): PipelineConfig {
  // Sessions → Workers KV. `env.SESSIONS` structurally satisfies KvNamespaceLike.
  const session = new KvSessionStore(env.SESSIONS)

  // Rate-limit + nonce → Durable Object. Route each KEY to the object that owns
  // it via `idFromName(key)` so a single bucket / nonce lives on a single serial
  // object — that is what makes them strongly consistent (no overspend / replay).
  const rateLimit = new DurableRateLimitStore((key) =>
    createFetchRateLimitStub(env.SECURITY_DO.get(env.SECURITY_DO.idFromName(key))),
  )
  const nonce = new DurableNonceStore((n) =>
    createFetchNonceStub(env.SECURITY_DO.get(env.SECURITY_DO.idFromName(n))),
  )

  // Signing keys: raw HMAC material from env secrets (hex), never in code
  // (SIGN-06). The demo client `demo-client` currently signs with `key-2026a`,
  // matching `examples/todo-api`'s single-client posture.
  const secrets = new EnvSecretProvider(
    { 'key-2026a': env.HMAC_KEY_2026A },
    { 'demo-client': 'key-2026a' },
  )

  // Origins from env (comma-separated) or the localhost dev fallback.
  const allowedOrigins = env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0)
    : ['http://localhost:3000']

  return {
    allowedOrigins,
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
    idleTtlSeconds: 900,
    session: { absoluteTtlSeconds: 8 * 60 * 60, sameSite: 'Lax' },
    stores: { session, rateLimit, nonce, secrets },
    // Per-deployment salt from a wrangler secret (RT-12); unsalted dev fallback.
    auditSalt: env.AUDIT_SALT,
    maxInFlight: 200,
    requestTimeoutMs: 15_000,
    logger: createConsoleLogger(),
    // TransportConfig hook — CF-Visitor scheme, fail-closed when absent (TLS-03).
    forwardedProtoHeader,
    // RateLimitConfig hook — spoof-resistant CF-Connecting-IP.
    clientIp,
    maxBodyBytes: 1_048_576,
    protocolContentType: 'application/json',
  }
}

/**
 * Build the Hono app for a request. Probes are registered BEFORE the security
 * pipeline so a platform health check bypasses assertHttps / rate limiting,
 * exactly as the example entries do.
 */
function buildApp(env: Env): Hono<SecurityEnv> {
  const config = buildConfig(env)
  // Fail fast on an incoherent config (e.g. signed ops with no secrets/nonce).
  validateConfig(OPERATIONS, config)

  const app = new Hono<SecurityEnv>()
  app.get('/healthz', healthHandler())
  app.get('/readyz', readinessHandler(config))
  app.use('*', ...createSecurityPipeline(OPERATIONS, config))
  app.route('/', createTodoRouter(todoOps))
  return app
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return buildApp(env).fetch(request)
  },
}
