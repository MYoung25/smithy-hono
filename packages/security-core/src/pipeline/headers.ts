/**
 * Pipeline phases 3–4 (S3) — security response headers + transport assertion.
 *
 * Replaces the `securityHeaders` and `assertHttps` placeholders in
 * `pipeline/index.ts`. Web-standard only (ARCH-01): everything is driven off the
 * Hono `Context`, the injected {@link SecurityConfig}, and the per-request
 * {@link PipelineOperationMeta} from the registry resolver — no `node:*`, no
 * module-level env reads (ARCH-05).
 *
 * Header values come from `config` + route-class (the resolved op), never from
 * module constants, so a deployment can re-policy without forking core (ARCH-05).
 */

import type { Context, MiddlewareHandler } from 'hono'
import type { SecurityConfig } from '../config.js'
// Type-only: never imports generated code; the structural shape is enough.
import type { PipelineOperationMeta } from './index.js'

/** Local mirror of the pipeline's `OpResolver` (kept local per parallel-safety). */
type OpResolver = (
  method: string,
  path: string,
) => PipelineOperationMeta | undefined

// ---------------------------------------------------------------------------
// Config surface this module needs folded into SecurityConfig (see report).
// ---------------------------------------------------------------------------

/**
 * Transport adapter hook (ARCH-01). The forwarded-proto header name differs per
 * platform — `X-Forwarded-Proto` (ALB/ingress), `CF-Visitor`/`cf` props
 * (Workers), API Gateway request context (Lambda) — so core never hardcodes it;
 * the adapter (`adapter-{cf,aws,node}`, Phase S10) supplies the resolver.
 */
export interface TransportConfig {
  /** Returns the effective request scheme, e.g. `'https'` / `'http'`, or undefined. */
  forwardedProtoHeader(c: Context): string | undefined
}

/**
 * Optional response-header policy overrides. All default to the hardened
 * API-JSON baseline from the S3 spec when omitted, so a service need set nothing.
 */
export interface HeadersConfig {
  headers?: {
    /**
     * `Content-Security-Policy` value for JSON API responses (HDR-03).
     * Default `default-src 'none'; frame-ancestors 'none'`.
     */
    csp?: string
    /** `Referrer-Policy` value (HDR-04). Default `no-referrer`. */
    referrerPolicy?: string
    /** `X-Frame-Options` value (HDR-02). Default `DENY`. */
    frameOptions?: string
    /** Emit HSTS `preload` token. Default false (TLS-02 "decide later"). */
    hstsPreload?: boolean
    /**
     * `Permissions-Policy` value (HDR-08). Default is a deny-by-default policy
     * that disables the high-risk browser features for a JSON API. Set to the
     * empty string `''` to suppress the header entirely.
     */
    permissionsPolicy?: string
    /**
     * `Cross-Origin-Resource-Policy` value (HDR-10). Default `same-origin`. Set
     * to the empty string `''` to suppress the header entirely.
     */
    corp?: string
    /**
     * `Cross-Origin-Opener-Policy` value (HDR-10). Default `same-origin`. Set to
     * the empty string `''` to suppress the header entirely.
     */
    coop?: string
  }
}

/** The config both S3 functions read — `SecurityConfig` plus this module's knobs. */
export type TransportHeadersConfig = SecurityConfig & TransportConfig & HeadersConfig

// ---------------------------------------------------------------------------
// Defaults (the hardened API-JSON baseline; overridable via HeadersConfig).
// ---------------------------------------------------------------------------

/** TLS-02: HSTS max-age MUST be at least one year. */
const MIN_HSTS_MAX_AGE = 31536000

const DEFAULT_CSP = "default-src 'none'; frame-ancestors 'none'"
const DEFAULT_REFERRER_POLICY = 'no-referrer'
const DEFAULT_FRAME_OPTIONS = 'DENY'
/**
 * HDR-08 deny-by-default `Permissions-Policy` — a JSON API never needs these
 * powerful browser features, so deny them all (empty allowlist `()`).
 */
const DEFAULT_PERMISSIONS_POLICY =
  'accelerometer=(), autoplay=(), camera=(), display-capture=(), ' +
  'encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), ' +
  'magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), ' +
  'usb=()'
/** HDR-10: isolate this origin's resources from cross-origin embedding/lookup. */
const DEFAULT_CORP = 'same-origin'
/** HDR-10: sever the opener relationship so cross-origin popups can't reach back. */
const DEFAULT_COOP = 'same-origin'

// ---------------------------------------------------------------------------
// securityHeaders — pipeline phase 3 (HSTS + hardened header set).
// ---------------------------------------------------------------------------

/**
 * Returns true when the resolved op is non-anonymous (i.e. an authenticated
 * route). Unknown routes (`undefined`) are treated as authenticated — fail
 * closed: `no-store` is the safer default for a route we can't classify.
 */
function isAuthenticatedOp(op: PipelineOperationMeta | undefined): boolean {
  if (!op) return true
  if (op.authSchemes.length === 0) return true
  return op.authSchemes.some((s) => s.type !== 'anonymous')
}

/**
 * Phase 3 — set the hardened security response header set on every response.
 *
 * - `Strict-Transport-Security` (TLS-02): `max-age=<hsts.maxAge>` plus
 *   `includeSubDomains` when enabled and optional `preload`.
 * - `X-Content-Type-Options: nosniff` (HDR-01).
 * - `X-Frame-Options` + CSP `frame-ancestors 'none'` framing protection (HDR-02).
 * - `Content-Security-Policy: default-src 'none'` JSON baseline (HDR-03).
 * - `Referrer-Policy: no-referrer` (HDR-04).
 * - `Permissions-Policy` deny-by-default (HDR-08) and `Cross-Origin-Resource-Policy`
 *   / `Cross-Origin-Opener-Policy: same-origin` (HDR-10); each config-overridable
 *   and suppressible via an explicit `''`.
 * - `Cache-Control: no-store` on authenticated routes (HDR-07), except streaming
 *   ops (`op.streaming`, from a `@sseStream` operation in the registry), which are
 *   exempt so the SSE stream controls its own caching. Unknown routes (op
 *   undefined) still get `no-store` — fail closed.
 *
 * Header values come from `config` + the resolved op (route-class), not module
 * constants (ARCH-05). Validates `hsts.maxAge` at construction (fail fast, TLS-02).
 */
export function securityHeaders(
  config: TransportHeadersConfig,
  resolve: OpResolver,
): MiddlewareHandler {
  // Fail fast on misconfig (TLS-02) — validate once, at construction.
  if (
    !Number.isFinite(config.hsts.maxAge) ||
    config.hsts.maxAge < MIN_HSTS_MAX_AGE
  ) {
    throw new Error(
      `securityHeaders: hsts.maxAge must be >= ${MIN_HSTS_MAX_AGE} seconds ` +
        `(one year, TLS-02); got ${config.hsts.maxAge}`,
    )
  }

  // Precompute the static header values (config-derived, request-independent).
  const hstsValue =
    `max-age=${config.hsts.maxAge}` +
    (config.hsts.includeSubDomains ? '; includeSubDomains' : '') +
    (config.headers?.hstsPreload ? '; preload' : '')
  const csp = config.headers?.csp ?? DEFAULT_CSP
  const referrerPolicy = config.headers?.referrerPolicy ?? DEFAULT_REFERRER_POLICY
  const frameOptions = config.headers?.frameOptions ?? DEFAULT_FRAME_OPTIONS
  // HDR-08/HDR-10 defense-in-depth headers. `?? DEFAULT` applies the hardened
  // baseline when omitted; an explicit `''` opts out (the header is then skipped).
  const permissionsPolicy =
    config.headers?.permissionsPolicy ?? DEFAULT_PERMISSIONS_POLICY
  const corp = config.headers?.corp ?? DEFAULT_CORP
  const coop = config.headers?.coop ?? DEFAULT_COOP

  const handler: MiddlewareHandler = async (c, next) => {
    await next()

    // Route-class awareness (HDR-02/07) from the registry, not hardcoded.
    const op = resolve(c.req.method, c.req.path)

    c.header('Strict-Transport-Security', hstsValue) // TLS-02
    c.header('X-Content-Type-Options', 'nosniff') //    HDR-01
    c.header('X-Frame-Options', frameOptions) //        HDR-02
    c.header('Content-Security-Policy', csp) //         HDR-02/03
    c.header('Referrer-Policy', referrerPolicy) //      HDR-04

    // HDR-08/HDR-10 defense-in-depth: emit each only when non-empty so an
    // explicit `''` override suppresses it.
    if (permissionsPolicy) c.header('Permissions-Policy', permissionsPolicy) // HDR-08
    if (corp) c.header('Cross-Origin-Resource-Policy', corp) //                 HDR-10
    if (coop) c.header('Cross-Origin-Opener-Policy', coop) //                   HDR-10

    // HDR-07: never let an authenticated response be cached by shared caches —
    // except streaming (@sseStream) ops, which control their own caching.
    if (isAuthenticatedOp(op) && !op?.streaming) {
      c.header('Cache-Control', 'no-store')
    }
  }
  Object.defineProperty(handler, 'name', { value: 'securityHeaders' })
  return handler
}

// ---------------------------------------------------------------------------
// assertHttps — pipeline phase 4 (reject plaintext, TLS-03).
// ---------------------------------------------------------------------------

/**
 * Phase 4 — assert the forwarded-proto is https; reject plaintext (TLS-03).
 *
 * Rejects with `400 InsecureTransport` rather than redirecting: a request that
 * already leaked credentials over http gains nothing from a redirect. The
 * forwarded-proto header name is platform-specific (ARCH-01), so it is read via
 * the adapter-supplied `config.forwardedProtoHeader`.
 *
 * A genuine CORS `OPTIONS` preflight is exempt from the proto check so it can
 * fall through to `cors` (slot 6) and be answered there, preserving the
 * documented "preflight short-circuits at CORS" invariant even over plaintext. A
 * preflight carries no credentials and no body, so skipping the TLS-03 check
 * leaks nothing; the subsequent ACTUAL request still hits `assertHttps` and is
 * rejected if it arrives over http.
 */
export function assertHttps(config: TransportHeadersConfig): MiddlewareHandler {
  const handler: MiddlewareHandler = async (c, next) => {
    // Genuine preflight (OPTIONS carrying an `Origin`) → defer to cors (slot 6).
    if (c.req.method === 'OPTIONS' && c.req.header('Origin') !== undefined) {
      return next()
    }
    const proto = config.forwardedProtoHeader(c)
    if (proto !== 'https') {
      return c.json({ code: 'InsecureTransport', message: 'HTTPS required' }, 400)
    }
    await next()
  }
  Object.defineProperty(handler, 'name', { value: 'assertHttps' })
  return handler
}
