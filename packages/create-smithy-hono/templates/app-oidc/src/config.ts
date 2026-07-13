/**
 * Construction-time wiring for the secure service (ARCH-05).
 *
 * Builds, from a set of injected dependencies, the TWO config objects the secure
 * service needs:
 *   - {@link PipelineConfig}   — read by `createSecurityPipeline` + `validateConfig`
 *   - {@link AuthRoutesConfig} — read by the OIDC route helpers (login/callback/…)
 *
 * Everything pluggable (the stores, the OIDC verifier, the logger/audit sink) is a
 * PARAMETER so the same wiring runs three ways unchanged:
 *   - production       → durable stores + a real remote OIDC verifier (the deploy entry)
 *   - the e2e test     → in-memory stores + a fake local-JWKS OIDC issuer (test/)
 *   - a dev boot       → in-memory stores + (optionally) the same fake issuer (src/index.ts)
 */

import {
  toAuthConfig,
  type PipelineConfig,
  type AuthRoutesConfig,
  type OidcVerifier,
  type PermissionMapper,
  type ServicePrincipalMapper,
  type Logger,
  type AuditSink,
  type SessionStore,
  type NonceStore,
  type SecretProvider,
} from '@smithy-hono/security-core'

/** The pluggable backends + collaborators the config is built from. */
export interface SecureExampleDeps {
  stores: {
    session: SessionStore
    nonce: NonceStore
    secrets: SecretProvider
  }
  /** A pre-built OIDC verifier (real remote JWKS in prod, local JWKS in tests). */
  oidcVerifier: OidcVerifier
  /** Injected structured logger (stdout JSON in prod). */
  logger: Logger
  /** Injected audit sink (a stdout sink in prod) — OPS-05. */
  audit: AuditSink
  /** Per-deployment pseudonymization salt (RT-12). */
  auditSalt: string
  /** OIDC issuer / endpoints / client identity. */
  oidc: {
    issuer: string
    clientId: string
    clientSecret?: string
    audience: string | string[]
    redirectUri: string
    authorizationEndpoint: string
    tokenEndpoint: string
  }
  /** HMAC secret signing the login↔callback transaction cookie. */
  oidcStateSecret: string
  /** Trust X-Forwarded-* (set only behind a trusted proxy). Default false → fail closed. */
  trustProxyHeaders?: boolean
  /** Allowed CORS origins for the browser SPA. */
  allowedOrigins?: string[]
  /**
   * Mount the whole service (probes, auth helpers, note router) under this path
   * prefix, e.g. `/api`. Default `''` (root). When set, the pipeline registry is
   * prefixed via `withBasePath` so per-op auth still resolves, and the logout
   * special-case path is derived from it.
   */
  basePath?: string
  /**
   * Resolve the forwarded protocol for `assertHttps` (S3/TLS-03). On Cloudflare
   * pass the adapter's CF-Visitor reader (`forwardedProtoHeader` from
   * `@smithy-hono/adapter-cf`); the default reads `x-forwarded-proto` only when
   * `trustProxyHeaders` is set. MUST yield `'https'` in prod or every request 400s.
   */
  forwardedProtoHeader?: PipelineConfig['forwardedProtoHeader']
  /** Resolve the spoof-resistant client IP for the rate limiter (S7). */
  clientIp?: PipelineConfig['clientIp']
}

// ---------------------------------------------------------------------------
// Claim → permission mapping (injected; core bakes in no IdP conventions).
// ---------------------------------------------------------------------------

/**
 * Map verified OIDC claims → permission scopes (AUTH-08). This reads a space- or
 * array-valued `scope`/`scp` claim (the common IdP conventions) and, failing that,
 * grants the base read/write scopes so the reference flow works against a minimal
 * IdP. A real deployment maps groups/roles to your scopes.
 */
export const mapPermissions: PermissionMapper = (claims) => {
  const raw = claims['scope'] ?? claims['scp'] ?? claims['permissions']
  if (typeof raw === 'string') return raw.split(/\s+/).filter(Boolean)
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string')
  // Minimal-IdP fallback: a verified user gets the note read/write scopes.
  return ['notes.read', 'notes.write']
}

// ---------------------------------------------------------------------------
// keyId → service Principal mapping for the S2S signed op (SIGN-11).
// ---------------------------------------------------------------------------

/**
 * Map a verified signing keyId → a scoped SERVICE principal. The S2S import op
 * requires the `notes.import` permission; we grant it to the demo importer key.
 * A real deployment derives scopes from a per-key directory.
 */
export const signingPrincipalMapper: ServicePrincipalMapper = (keyId) => ({
  id: keyId,
  permissions: ['notes.import'],
  claims: { keyId },
  kind: 'service',
})

// ---------------------------------------------------------------------------
// Config builders.
// ---------------------------------------------------------------------------

export function buildPipelineConfig(deps: SecureExampleDeps): PipelineConfig {
  const trust = deps.trustProxyHeaders ?? false
  return {
    allowedOrigins: deps.allowedOrigins ?? ['http://localhost:3000'],
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
    idleTtlSeconds: 900,
    // OIDC cookie sessions (AUTH-05/06).
    session: { absoluteTtlSeconds: 8 * 60 * 60, sameSite: 'Lax' },
    // S2S signing policy: ±5 min window. ImportNotes is non-@readonly, so it is
    // nonce-tracked by default (RT-06) against stores.nonce below.
    signing: { acceptanceWindowSeconds: 300 },
    // keyId → scoped service principal (SIGN-11).
    signingPrincipalMapper,
    // Pluggable backends (ARCH-03) — durable adapter stores in prod, fakes in tests.
    stores: {
      session: deps.stores.session,
      nonce: deps.stores.nonce,
      secrets: deps.stores.secrets,
    },
    // OIDC verifier config is module-local to the route helpers, but the canonical
    // fields are mirrored here so validateConfig sees a coherent oidc block.
    oidc: {
      issuer: deps.oidc.issuer,
      clientId: deps.oidc.clientId,
      audience: deps.oidc.audience,
      redirectUri: deps.oidc.redirectUri,
      authorizationEndpoint: deps.oidc.authorizationEndpoint,
      tokenEndpoint: deps.oidc.tokenEndpoint,
      stateSecret: deps.oidcStateSecret,
    },
    auditSalt: deps.auditSalt,
    logger: deps.logger,
    audit: deps.audit,
    maxInFlight: 200,
    requestTimeoutMs: 15_000,
    // Logout special-case path tracks the mount prefix so idempotent logout still
    // fires under `/api` (see authenticate.ts / SecurityConfig.logoutPath).
    logoutPath: `${deps.basePath ?? ''}/auth/logout`,
    forwardedProtoHeader:
      deps.forwardedProtoHeader ??
      ((c) => (trust ? c.req.header('x-forwarded-proto') ?? 'https' : undefined)),
    maxBodyBytes: 1_048_576,
    protocolContentType: 'application/json',
    clientIp:
      deps.clientIp ??
      ((c) => (trust ? c.req.header('x-forwarded-for') ?? '127.0.0.1' : 'untrusted-direct')),
  }
}

export function buildAuthRoutesConfig(
  deps: SecureExampleDeps,
  pipelineConfig: PipelineConfig,
): AuthRoutesConfig {
  return {
    store: deps.stores.session,
    // OIDC session options reuse the unified config's session lifecycle (OPS-06).
    session: { ...toAuthConfig(pipelineConfig) },
    oidc: {
      issuer: deps.oidc.issuer,
      audience: deps.oidc.audience,
    },
    clientId: deps.oidc.clientId,
    clientSecret: deps.oidc.clientSecret,
    redirectUri: deps.oidc.redirectUri,
    authorizationEndpoint: deps.oidc.authorizationEndpoint,
    tokenEndpoint: deps.oidc.tokenEndpoint,
    scopes: ['openid', 'profile', 'email'],
    mapPermissions,
    stateSecret: deps.oidcStateSecret,
    // Reuse a single pre-built verifier so the JWKS cache stays warm.
    verifier: deps.oidcVerifier,
  }
}
