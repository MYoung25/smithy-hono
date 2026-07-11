/**
 * `@smithy-hono/security-core` — runtime-agnostic security primitives.
 *
 * Web-standard APIs only (ARCH-01): no `node:*`, no `Buffer`, no module-level
 * env reads (ARCH-05). Phase S0 surface = the four storage interfaces, the
 * config-injection convention, and the dev-only in-memory implementations.
 */

// Storage interfaces + supporting types (ARCH-03).
export type {
  Principal,
  SessionStore,
  SessionRecord,
  RateLimitStore,
  TokenBucketSpec,
  RateDecision,
  NonceStore,
  SecretProvider,
} from './storage/index.js'

// Dev-only in-memory implementations (ARCH-02 — single-process only).
export {
  MemorySessionStore,
  MemoryRateLimitStore,
  MemoryNonceStore,
  MemorySecretProvider,
} from './storage/memory.js'

// Config-injection convention (ARCH-05).
export type {
  SecurityConfig,
  StoreBindings,
  HstsConfig,
  SigningConfig,
  OidcConfigFields,
  SessionConfigFields,
  RateLimitDefaults,
  Logger,
  AuditSink,
  AuditEvent,
  AuditEventType,
  MetricsSink,
  MetricSignal,
} from './config.js'

// Pipeline skeleton + canonical ordering (ARCH-07, Phase S2).
export {
  createSecurityPipeline,
  resolveOp,
  withBasePath,
} from './pipeline/index.js'
export type {
  OperationRegistry,
  PipelineOperationMeta,
  PipelineAuthScheme,
  PipelineConfig,
} from './pipeline/index.js'

// Operation-tier authorization hook emitted by codegen (AUTHZ-01/02).
export { authorize } from './pipeline/authorize.js'
export type { AuthorizableOperation } from './pipeline/authorize.js'

// Typed context variables the pipeline populates (ARCH-07).
export type { SecurityVariables, SecurityEnv } from './pipeline/context.js'

// S3 — transport assertion + security headers (TLS-*, HDR-*).
export { securityHeaders, assertHttps } from './pipeline/headers.js'
export type {
  TransportConfig,
  HeadersConfig,
  TransportHeadersConfig,
} from './pipeline/headers.js'

// S4 — input-validation guards (VAL-*).
export {
  bodyGuards,
  headerGuards,
  assertWithinStructuralLimits,
  DEFAULT_STRUCTURAL_LIMITS,
  readBoundedBody,
  BodyTooLargeError,
  StructuralLimitError,
} from './pipeline/bodyGuards.js'
export type { ValidationConfig, StructuralLimits } from './pipeline/bodyGuards.js'

// S5 — authentication (AUTH-*).
export { authenticate } from './pipeline/authenticate.js'
export {
  issueSession,
  rotateSession,
  sessionFromOidcClaims,
  principalFromOidcClaims,
  generateToken,
  timingSafeEqual,
  buildSessionCookie,
  clampIdleToAbsolute,
  DEFAULT_SESSION_COOKIE_NAME,
} from './auth/session.js'
export { toAuthConfig } from './auth/session.js'
export type {
  AuthConfig,
  SameSite,
  IssuedSession,
  PermissionMapper,
  OidcSessionOptions,
} from './auth/session.js'

// OPS-06 — fail-fast config validation.
export { validateConfig, collectConfigIssues, ConfigValidationError } from './validateConfig.js'
export type { ConfigIssue } from './validateConfig.js'

// OPS-04 — health/readiness handlers (graceful-shutdown guidance in the module doc).
export { healthHandler, readinessHandler } from './pipeline/health.js'
export type { ReadinessProbe, ReadinessOptions } from './pipeline/health.js'

// S5 — OIDC ID-token verifier (RT-03). Branded VerifiedClaims; the ONLY module
// that imports jose. Tree-shakeable: non-OIDC deploys don't load it.
export {
  createOidcVerifier,
  verifyIdToken,
  assertVerifiedClaims,
  OidcVerificationError,
  OidcConfigError,
} from './auth/oidc.js'
export type {
  VerifiedClaims,
  OidcConfig,
  OidcVerifier,
  VerifyIdTokenOptions,
} from './auth/oidc.js'

// S5 — OIDC auth route helpers (RT-04) + session-rotation wiring (RT-05).
export {
  loginHandler,
  callbackHandler,
  logoutHandler,
  csrfTokenHandler,
} from './auth/routes.js'
export type { AuthRoutesConfig, CallbackResult } from './auth/routes.js'

// S7 — rate limiting & DoS resistance (RATE-*).
export {
  rateLimitPerIp,
  rateLimitPerPrincipal,
  authRateLimit,
  withTimeout,
  loadShedder,
} from './pipeline/rateLimit.js'
export type { RateLimitConfig } from './pipeline/rateLimit.js'

// S8 — CORS + CSRF (CORS-*, CSRF-*).
export { cors } from './pipeline/cors.js'
export type { CorsConfig, CorsPipelineConfig } from './pipeline/cors.js'
export { csrf } from './pipeline/csrf.js'
export type { CsrfConfig, CsrfPipelineConfig } from './pipeline/csrf.js'

// S9 — request id + structured logger + error sanitizer (LOG-*, HDR-05).
export { requestId } from './pipeline/requestId.js'
export { structuredLogger } from './pipeline/logging.js'
export {
  errorSanitizer,
  isModeledError,
  serializeForLog,
} from './pipeline/errorSanitizer.js'
export type { ModeledError } from './pipeline/errorSanitizer.js'

// S9 — audit infrastructure (LOG-10/11/12).
export {
  pseudonymize,
  createPseudonymizer,
  defaultPseudonymize,
  buildAuditEvent,
  emitAudit,
  canonical,
  ChainedAuditSink,
} from './audit/audit.js'
export type { Pseudonymizer, AuditEventInput } from './audit/audit.js'
export { redactSensitive, REDACTED } from './audit/redact.js'

// LOG-08 — operational signals (5xx, rate-limit saturation, cert-expiry hook).
export {
  buildMetricSignal,
  emitMetric,
  emitRateLimitSaturation,
  emitFiveXx,
  emitCertExpiry,
} from './audit/metrics.js'
export type {
  MetricSignalType,
  MetricSignalInput,
} from './audit/metrics.js'

// S5b — resource-tier authorization (AUTHZ-*). Op-tier `authorize` is above.
export {
  requireResourcePolicy,
  isOwner,
  sameTenant,
  all,
  any,
  RESOURCE_CONTEXT_KEY,
} from './authz/resourcePolicy.js'
export type {
  ResourcePolicy,
  PolicyContext,
  PolicyDecision,
  AuthorizedOperationMeta,
  RequireResourcePolicyOptions,
  SameTenantOptions,
} from './authz/resourcePolicy.js'

// S6 — S2S HMAC request signing & verification (SIGN-*).
// Raw request bytes for signature verification (ARCH-08 spike).
export { readRawBody } from './signing/rawBody.js'
// Canonicalization contract (SH-HMAC-SHA256) — shared by signer + verifier.
export {
  SH_HMAC_SHA256,
  AUTHORIZATION_HEADER,
  TIMESTAMP_HEADER,
  BODY_SHA256_HEADER,
  buildCanonicalString,
  canonicalQuery,
  canonicalHeaders,
  encodeRfc3986,
  parseAuthorizationHeader,
  formatAuthorizationHeader,
  sha256Hex,
  toHex,
  fromHex,
  asBufferSource,
} from './signing/canonical.js'
export type { CanonicalParts, ParsedAuthorization } from './signing/canonical.js'
// Reference signer (test oracle + seed of the public SDK).
export { signRequest, importHmacKey } from './signing/signer.js'
export type { SignRequestInput, SignedRequest, SignableBody } from './signing/signer.js'
// Verifier middleware (pipeline slot 10).
export { verifySignature } from './signing/verifySignature.js'
export type {
  SigningModuleConfig,
  VerifySignatureConfig,
  ServicePrincipalMapper,
} from './signing/verifySignature.js'
