import { Hono } from 'hono'
import {
  createSecurityPipeline,
  MemorySessionStore,
  MemorySecretProvider,
  MemoryNonceStore,
  validateConfig,
  healthHandler,
  readinessHandler,
  type PipelineConfig,
  type SecurityEnv,
} from '@smithy-hono/security-core'
import { createTodoRouter } from '../generated/todo.gen'
import { OPERATIONS } from '../generated/registry.gen'
import { todoOps } from './implementation'

// ─────────────────────────────────────────────────────────────────────────────
// TRUSTED-HOP BOUNDARY (read before touching the proto/IP resolvers below).
//
// `X-Forwarded-Proto` and `X-Forwarded-For` are CLIENT-CONTROLLED unless a
// trusted reverse proxy / load balancer terminates the connection and OVERWRITES
// them. A directly-reachable instance that trusts these headers is wide open:
//   - any client can send `X-Forwarded-Proto: https` to satisfy the TLS check
//     (TLS-03) while actually talking plaintext, and
//   - any client can rotate `X-Forwarded-For` to mint unlimited per-IP rate
//     buckets (RATE-01 bypass) or poison a victim's bucket.
//
// So we FAIL CLOSED by default: with no trusted proxy, the proto resolver returns
// `undefined` (→ `assertHttps` rejects with 400 InsecureTransport) and the IP
// resolver returns a single fixed sentinel (→ all callers share ONE strict
// per-IP bucket instead of getting unlimited spoofable buckets).
//
// In production you put this app BEHIND a proxy that strips inbound forwarded
// headers and sets its own, then flip `TRUST_PROXY_HEADERS=1` so the resolvers
// read the (now trustworthy) headers. The dev fallbacks below are gated behind
// the SAME opt-in so a plain `node`/`tsx` run is still ergonomic locally.
// ─────────────────────────────────────────────────────────────────────────────

// DEV-ONLY opt-in. Set `TRUST_PROXY_HEADERS=1` ONLY when this instance is either
// (a) behind a trusted proxy that overwrites the X-Forwarded-* headers, or
// (b) a local dev box where you accept plaintext + a single shared rate bucket.
// Defaults OFF → fail closed.
const TRUST_PROXY_HEADERS = process.env.TRUST_PROXY_HEADERS === '1'

// Injected at construction (ARCH-05). S3 (headers/transport), S4 (validation),
// S7 (rate limit), S8 (CORS/CSRF) and S9 (logging) are now real; only S6
// (signature verification) remains a named pass-through until it lands.
// Exported so the MCP wiring (`mcpAuth.ts`, Plan 14 §11.4) can mount `/mcp` on a
// Hono app that carries the SAME security pipeline this REST app does — `/mcp`
// coexists as a distinct OAuth resource server behind the identical slots 1–8.
export const securityConfig: PipelineConfig = {
  allowedOrigins: ['http://localhost:3000'],
  hsts: { maxAge: 31_536_000, includeSubDomains: true },
  idleTtlSeconds: 900,
  // OPS-06 — session lifecycle on the unified config object (build an AuthConfig
  // from this with `toAuthConfig(securityConfig)` when issuing cookie sessions).
  session: { absoluteTtlSeconds: 8 * 60 * 60, sameSite: 'Lax' },
  // This service serves OIDC (cookie) AND sigv4Hmac (S2S signed) operations, so a
  // coherent config needs session + secrets + nonce stores — validateConfig() below
  // fails fast if any is missing. (In-memory here; real deployments inject backed
  // stores — see the adapters.)
  stores: {
    session: new MemorySessionStore(),
    secrets: new MemorySecretProvider(),
    nonce: new MemoryNonceStore(),
  },
  // Per-deployment pseudonymization salt (RT-12) — keyed audit/log principal refs.
  auditSalt: 'example-dev-salt-replace-in-production',
  // OPS-04 — DoS resistance (opt-in): shed past 200 concurrent in-flight requests
  // (RATE-05) and time out any request over 15s (RATE-04).
  maxInFlight: 200,
  requestTimeoutMs: 15_000,
  // Surface config warnings + the wide-open-limiter notice (RT-07/OPS-06).
  logger: {
    info: (r) => console.log(JSON.stringify({ level: 'info', ...r })),
    warn: (r) => console.warn(JSON.stringify({ level: 'warn', ...r })),
    error: (r) => console.error(JSON.stringify({ level: 'error', ...r })),
  },
  // S3 transport (TLS-03). FAIL CLOSED: only trust `X-Forwarded-Proto` when the
  // explicit proxy opt-in is set; the dev fallback to `'https'` lives behind it.
  // Otherwise return `undefined` so `assertHttps` rejects (400 InsecureTransport)
  // rather than letting a spoofed plaintext request satisfy the TLS check.
  forwardedProtoHeader: (c) =>
    TRUST_PROXY_HEADERS ? c.req.header('x-forwarded-proto') ?? 'https' : undefined,
  // S4 validation (VAL-04/06): 1 MiB body cap, restJson1 content-type.
  maxBodyBytes: 1_048_576,
  protocolContentType: 'application/json',
  // S7 rate limit (RATE-01). FAIL CLOSED: only trust `X-Forwarded-For` (and the
  // dev `'127.0.0.1'` fallback) when the proxy opt-in is set. Otherwise key every
  // caller on ONE fixed sentinel so they share a single strict bucket — never
  // give a spoofable client unlimited per-IP buckets. (No `rateLimits` specs are
  // configured here, so the limiter slots are graceful no-ops and emit a one-time
  // wide-open warning via the injected logger.)
  clientIp: (c) =>
    TRUST_PROXY_HEADERS
      ? c.req.header('x-forwarded-for') ?? '127.0.0.1'
      : 'untrusted-direct',
}

// OPS-06 — fail fast at boot on an incoherent config (e.g. cookie-auth ops with no
// session store, signed ops with no secrets/nonce store, wildcard CORS). Non-fatal
// issues (no audit salt, half-configured limiter) are logged via the logger above.
validateConfig(OPERATIONS, securityConfig)

const app = new Hono<SecurityEnv>()

// OPS-04 — health/readiness. Registered BEFORE the security pipeline so the probes
// bypass it (a `*` middleware registered later never runs once these return): a
// load-balancer probe must not be rejected by assertHttps or rate limiting.
// /healthz = liveness (process up); /readyz = readiness (configured stores respond).
app.get('/healthz', healthHandler())
app.get('/readyz', readinessHandler(securityConfig))

// Pre-deserialization security pipeline, canonical order (ARCH-07).
app.use('*', ...createSecurityPipeline(OPERATIONS, securityConfig))

app.route('/', createTodoRouter(todoOps))

// Graceful shutdown (Node): flip readiness to 503 first so the LB drains you, let
// in-flight requests finish (bounded by requestTimeoutMs), then close + exit. See
// the `health.ts` module doc for the per-runtime guidance.

export default app
