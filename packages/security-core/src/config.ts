/**
 * Config injection convention (ARCH-05).
 *
 * The single object every middleware reads from. **No `process.env` reads and no
 * module-level env access anywhere in core** — the Workers/Lambda env is read in
 * the *service entrypoint* (per-request on Workers) and passed in here. This
 * module declares only types; it constructs nothing and reads nothing global.
 */

import type {
  NonceStore,
  RateLimitStore,
  SecretProvider,
  SessionStore,
  TokenBucketSpec,
} from './storage/index.js'
// Canonical home of the LOG-08 metrics sink/signal types; re-exported below so the
// injected-sink surface reads as one place (the type-only cycle is fine for TS).
import type { MetricsSink, MetricSignal } from './audit/metrics.js'

// ---------------------------------------------------------------------------
// Logging / audit sinks (LOG-*, doc 10) — injected, never chosen by core.
// ---------------------------------------------------------------------------

/**
 * Minimal structured-logging sink (LOG-01/04). The transport (Workers console →
 * Logpush, Lambda → CloudWatch, Node → stdout JSON) is a deployment concern;
 * core only calls these methods with sanitized, PII-free records.
 */
export interface Logger {
  info(record: Record<string, unknown>): void
  warn(record: Record<string, unknown>): void
  error(record: Record<string, unknown>): void
}

/** The typed, versioned audit event categories emitted at-source (LOG-10). */
export type AuditEventType =
  | 'auth.success'
  | 'auth.failure'
  | 'authz.deny'
  | 'ratelimit.trip'
  | 'sig.fail'
  | 'session.create'
  | 'session.rotate'
  | 'session.revoke'
  | 'key.rotate'

/**
 * A typed, versioned audit record (LOG-10..12). Emitted the moment its event
 * occurs by the relevant middleware; `principalRef` is a pseudonymized
 * identifier, never raw PII (LOG-11). Hash-chain fields are present only when
 * the (default-off) chain is enabled (LOG-12).
 */
export interface AuditEvent {
  type: AuditEventType
  /** RFC3339 timestamp. */
  ts: string
  requestId: string
  /** Pseudonymized principal identifier — never PII (LOG-11). */
  principalRef: string | null
  operation?: string
  outcome: 'allow' | 'deny' | 'error'
  /** Sanitized, structured detail. Never secrets/credentials. */
  detail?: Record<string, unknown>
  // Hash-chain fields — present only when the chain is enabled (LOG-12).
  seq?: number
  prevHash?: string
  hash?: string
}

/** Injected audit destination (ARCH-05). Separate from the request {@link Logger}. */
export interface AuditSink {
  emit(event: AuditEvent): Promise<void>
}

/**
 * Injected operational-metrics destination (LOG-08, ARCH-05). Separate from the
 * request {@link Logger} and the {@link AuditSink}: emits structured operational
 * signals (5xx, rate-limit saturation, cert expiry) a deployment alerts on. The
 * interface + signal TYPES live in `./audit/metrics.js`; re-exported here next to
 * the other injected sinks so the config surface reads as one place. `emit` is
 * fire-and-forget so a signal never adds latency to the request path.
 */
export type { MetricsSink, MetricSignal }

// ---------------------------------------------------------------------------
// Sub-configs.
// ---------------------------------------------------------------------------

/** HSTS header policy (HDR-*). */
export interface HstsConfig {
  /** `max-age` in seconds. */
  maxAge: number
  includeSubDomains: boolean
}

/** Session-cookie lifecycle fields on the unified config (AUTH-05/06, OPS-06). */
export interface SessionConfigFields {
  /** Absolute session lifetime in seconds — the hard cap a slide can't lift (AUTH-05). */
  absoluteTtlSeconds: number
  /** Cookie name — keep the `__Host-` prefix to inherit its guarantees (AUTH-06). */
  cookieName?: string
  /** Cookie `SameSite` attribute (AUTH-03). Defaults to `Lax`. */
  sameSite?: 'Lax' | 'Strict'
}

/** OIDC browser-auth config (Phase S5, AUTH-08, RT-03/04). */
export interface OidcConfigFields {
  /** IdP issuer URL — the `iss` claim and OIDC discovery base. */
  issuer: string
  /** OAuth/OIDC client id — the expected ID-token `aud` and authorize/token `client_id`. */
  clientId: string
  /** Expected audience(s). Usually equal to `clientId`; array for multi-audience IdPs. */
  audience: string | string[]
  /** Registered redirect URI where the callback handler is mounted. */
  redirectUri: string
  /** IdP authorize endpoint (from discovery or static config). */
  authorizationEndpoint: string
  /** IdP token endpoint (authorization-code exchange). */
  tokenEndpoint: string
  /** Explicit JWKS URI, bypassing discovery (optional). */
  jwksUri?: string
  /** Confidential-client secret for token exchange (optional for public PKCE clients). */
  clientSecret?: string
  /** Requested scopes. Default `['openid']`. */
  scopes?: string[]
  /** Clock-skew tolerance for exp/iat, seconds. Default 60. */
  clockToleranceSeconds?: number
  /**
   * HMAC secret signing the login↔callback transaction cookie (`__Host-oidc-tx`).
   * High-entropy, per-deployment; NOT the session/audit secret.
   */
  stateSecret: string
}

/** S2S HMAC request-signing policy (SIGN-*). */
export interface SigningConfig {
  /** ±window for timestamp acceptance, seconds (SIGN-02 default ±5 min). */
  acceptanceWindowSeconds: number
  /**
   * Replay/nonce tracking is OPT-OUT (RT-06): every non-`@readonly` signed op is
   * tracked by default, so a state-changing S2S op cannot be replayed within the
   * acceptance window even if the integrator never configured it. List operation
   * names here only to EXEMPT a non-readonly op that is genuinely safe to replay.
   */
  replaySafeOps?: string[]
  /**
   * Operation names that ADDITIONALLY require nonce tracking even when `@readonly`
   * (SIGN-03 opt-in). Non-readonly ops are already tracked by default; use this to
   * force tracking on an otherwise-idempotent readonly op.
   */
  nonceForOps?: string[]
}

/**
 * Default token-bucket specs for the limiter phases (RATE-01). Per-operation
 * overrides come from the `@cost` registry data (RATE-07) at consume time.
 */
export interface RateLimitDefaults {
  /** Coarse per-IP bucket (pipeline phase 7, pre-auth). */
  perIp?: TokenBucketSpec
  /** Per-principal bucket (pipeline phase 11, post-auth). */
  perPrincipal?: TokenBucketSpec
}

/** The pluggable storage backends (ARCH-03), each optional until a phase needs it. */
export interface StoreBindings {
  session?: SessionStore
  rateLimit?: RateLimitStore
  nonce?: NonceStore
  secrets?: SecretProvider
}

// ---------------------------------------------------------------------------
// The injected config object.
// ---------------------------------------------------------------------------

/**
 * The construction-time config every security middleware reads (ARCH-05).
 * Assembled in the service entrypoint from the runtime env and passed down.
 */
export interface SecurityConfig {
  /** Allowed CORS origins (CORS-*). */
  allowedOrigins: string[]
  /** HSTS policy (HDR-*). */
  hsts: HstsConfig
  /** Idle-timeout TTL slid on each authenticated request, seconds (AUTH-05). */
  idleTtlSeconds: number
  /**
   * Session-cookie lifecycle (AUTH-05/06), folded here so there is ONE typed config
   * object end-to-end (OPS-06). `idleTtlSeconds` above is the idle slide; these are
   * the rest. Build an {@link import('./auth/session.js').AuthConfig} from this via
   * `toAuthConfig(config)`. Absent when no cookie session is issued.
   */
  session?: SessionConfigFields
  /** S2S HMAC signing policy — absent when no S2S ops are served. */
  signing?: SigningConfig
  /** Default rate-limit buckets — absent when limiting is off. */
  rateLimits?: RateLimitDefaults
  /** Pluggable storage backends (ARCH-03). */
  stores: StoreBindings
  /** Injected structured logger (LOG-01). */
  logger?: Logger
  /** Injected audit sink (LOG-10). */
  audit?: AuditSink
  /** Injected operational-metrics sink (LOG-08) — 5xx, limiter saturation, cert expiry. */
  metrics?: MetricsSink
  /**
   * OIDC browser-auth config (AUTH-08, RT-03/04) — absent when no OIDC login flow
   * is served. The OIDC verifier (`createOidcVerifier`) and route helpers
   * (`loginHandler`/`callbackHandler`/…) take their own module-local config slices
   * built from these canonical fields.
   */
  oidc?: OidcConfigFields
  /**
   * Per-deployment salt/key for principal pseudonymization (LOG-11, RT-12). When
   * set, audit/log principal refs use keyed HMAC-SHA-256 so refs are not
   * correlatable across deployments nor reversible without the key. PRODUCTION
   * deployments MUST set a high-entropy, per-deployment value; when absent the
   * refs fall back to an unsalted hash (correlatable — dev/test only).
   */
  auditSalt?: string
  /**
   * When `true`, a missing/empty {@link auditSalt} is a FATAL boot error rather
   * than a warning (RT-12) — opt in for production to fail closed instead of
   * silently pseudonymizing with an unsalted, correlatable hash. Defaults to
   * `false` (warn only) to preserve the dev/test experience.
   */
  requireAuditSalt?: boolean
  /**
   * Path of the cookie-authed `POST` logout route, used by `authenticate` to
   * special-case idempotent logout (clear the cookie + 204 even on a stale/absent
   * session). Defaults to `/auth/logout`. Set this when the service is mounted
   * under a base path (e.g. `/api/auth/logout`) so the special-case still fires —
   * keep it in agreement with the prefix passed to `withBasePath` (RT-04).
   */
  logoutPath?: string
}
