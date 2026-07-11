/**
 * `createSecurityPipeline` — the canonical pre-deserialization middleware stack
 * (ARCH-07, doc 03), composed once here so no other phase has to reason about
 * ordering.
 *
 * The pipeline is an **ordered array** of Hono middleware mounted at the app level
 * (`app.use('*', ...createSecurityPipeline(OPERATIONS, config))`). The order is the
 * canonical list from `00-overview.md`, outermost → innermost:
 *
 *   1  request-id              (S9)
 *   2  structured-logger       (S9)
 *   3  error-sanitizer         (S9)
 *   4  security-headers        (S3)
 *   5  assert-https            (S3)
 *   6  cors                    (S8) — OPTIONS preflight short-circuits here
 *  7a  header-guards           (S4) — cheap header-only 413/415, BEFORE the limiter
 *   8  rate-limit-per-ip       (S7)
 *  7b  body-guards             (S4) — buffer+decode+parse+walk, AFTER the limiter
 *   9  authenticate            (S5) → sets c.get('principal')
 *  10  verify-signature        (S6) — S2S (sigv4Hmac) ops only
 *  11  csrf                    (S8) — cookie-auth requests only
 *  12  rate-limit-per-principal(S7)
 *
 * PIPELINE-MW-01: body work is split — the cheap header-only checks (`headerGuards`)
 * run before the per-IP limiter so a body-carrying flood is 413/415'd or shed before
 * any request pays the buffer+decode+parse+structural-walk cost in `bodyGuards`,
 * which runs after the limiter but before authenticate/verifySignature.
 *
 * The pipeline is **fully wired**: every slot below is backed by a real
 * implementation imported from its phase module (S3–S9) — no pass-through
 * placeholders remain. What MUST stay correct: the exact ordering, the OPTIONS
 * short-circuit slot (phase 6), the per-operation conditional wiring
 * (`resolveOp` → `OperationMeta`), and the unknown-route behavior (generic guards
 * still run; Hono 404s). The factory also mounts the opt-in OPS-04 DoS guards
 * (load-shedder + per-request timeout) between cors and the heavy phases.
 */

import type { MiddlewareHandler } from 'hono'
import type { SecurityConfig } from '../config.js'
import { requestId } from './requestId.js'
import { structuredLogger } from './logging.js'
import { errorSanitizer } from './errorSanitizer.js'
import { securityHeaders, assertHttps } from './headers.js'
import type { TransportConfig, HeadersConfig } from './headers.js'
import { cors } from './cors.js'
import type { CorsConfig } from './cors.js'
import { bodyGuards, headerGuards } from './bodyGuards.js'
import type { ValidationConfig } from './bodyGuards.js'
import { rateLimitPerIp, rateLimitPerPrincipal, withTimeout, loadShedder } from './rateLimit.js'
import type { RateLimitConfig } from './rateLimit.js'
import { authenticate } from './authenticate.js'
import { verifySignature } from '../signing/verifySignature.js'
import type { SigningModuleConfig } from '../signing/verifySignature.js'
import { csrf } from './csrf.js'
import type { CsrfConfig } from './csrf.js'

/**
 * The complete config `createSecurityPipeline` requires: the base
 * {@link SecurityConfig} plus the per-phase knobs each implemented phase reads
 * — S3 transport/headers, S4 validation, S6 signing (the keyId→Principal mapper),
 * S7 rate-limit (`clientIp`), S8 CORS/CSRF. A service constructs one of these in
 * its entrypoint and passes it in (ARCH-05).
 */
export type PipelineConfig = SecurityConfig &
  TransportConfig &
  HeadersConfig &
  ValidationConfig &
  RateLimitConfig &
  CorsConfig &
  CsrfConfig &
  SigningModuleConfig

// ---------------------------------------------------------------------------
// Registry shape — structurally typed so core never imports generated code.
// The codegen-emitted `OperationMeta`/`OPERATIONS` (registry.gen.ts) is assignable.
// ---------------------------------------------------------------------------

/** The subset of an authentication scheme the pipeline branches on. */
export interface PipelineAuthScheme {
  type: 'oidc' | 'sigv4Hmac' | 'anonymous'
}

/** The operation metadata the pipeline reads to decide which guards engage. */
export interface PipelineOperationMeta {
  name: string
  method: string
  /** Hono-style path pattern, e.g. `/todos/:id`. */
  path: string
  authSchemes: PipelineAuthScheme[]
  readonly: boolean
  /** True for SSE/streaming ops (@sseStream); exempts them from Cache-Control: no-store. */
  streaming?: boolean
  requiredPermissions: string[]
  cost: number
  constraints: { maxBodyBytes?: number; hasConstrainedInput: boolean }
  /**
   * Dot-paths of `@sensitive` input/output members (RT-13/LOG-03). The codegen emits
   * these into the registry; pass them to `redactSensitive` (`audit/redact.ts`)
   * before logging any model-derived value so sensitive fields are scrubbed.
   */
  sensitiveFields?: string[]
  /**
   * Optional caller-kind allow-list (AUTHZ-03) mirrored from
   * {@link import('./authorize.js').AuthorizableOperation}. When present, the
   * `authorize` phase denies (403) a principal whose `kind` is not listed. Absent
   * (the default) imposes no kind restriction. NOTE: codegen does not yet emit this
   * from a Smithy trait — the field is declared additively so a registry MAY carry
   * it and `authorize` already honors it; wiring it from the model is deferred.
   */
  allowedPrincipalKinds?: ('user' | 'service')[]
}

/** The emitted `OPERATIONS` map: operation name → metadata. */
export type OperationRegistry = Record<string, PipelineOperationMeta>

// ---------------------------------------------------------------------------
// resolveOp — match a live request (method + concrete path) → OperationMeta.
// ---------------------------------------------------------------------------

/** Pre-compiled matcher for one registry route. */
interface CompiledRoute {
  method: string
  regex: RegExp
  meta: PipelineOperationMeta
  /** Count of static (non-param) segments — used to order most-specific-first. */
  staticSegments: number
  /** Total segment count — secondary tiebreaker, mirroring Hono specificity. */
  totalSegments: number
}

/**
 * Turn a Hono path pattern (`/todos/:id`) into an anchored regex that matches a
 * concrete request path (`/todos/123`). Params (`:name`) match a single segment.
 *
 * Anchored with a STRICT `$` end (not the laxer `/?$`) so the matcher accepts
 * exactly what Hono's default (strict, no-trailing-slash) router accepts — e.g.
 * `/todos/123/` no longer resolves to an op when Hono would 404 it (AUTHZ-02).
 */
function compilePath(pattern: string): RegExp {
  const escaped = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        // A greedy/wildcard param — `:name{*}` (emitted by the codegen for a Smithy
        // greedy label `{+path}`) or a trailing `+`/`*` — matches the multi-segment
        // TAIL, so it must span `/`; a plain `:name` matches exactly one segment.
        // Without this, `/files/:path{*}` would compile to `^/files/[^/]+$` and
        // resolveOp would miss `/files/a/b/c` that Hono's greedy route dispatches.
        return /\{\*\}$/.test(seg) || /[*+]$/.test(seg) ? '.+' : '[^/]+'
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return new RegExp(`^${escaped}$`)
}

/**
 * Left-to-right per-segment tiebreaker mirroring Hono's trie priority: when two
 * patterns tie on static/total segment counts, prefer the one whose first
 * differing segment is STATIC (non-`:`) over a param. Returns <0 if `aPath` is
 * more specific, >0 if `bPath` is, 0 if indistinguishable. Without this, `/:a/b`
 * and `/x/:c` tie and insertion order decides which op a request like `/x/b` (that
 * matches both) resolves to — potentially disagreeing with Hono's dispatch.
 */
function comparePerSegmentSpecificity(aPath: string, bPath: string): number {
  const aSegs = aPath.split('/')
  const bSegs = bPath.split('/')
  const n = Math.min(aSegs.length, bSegs.length)
  for (let i = 0; i < n; i++) {
    const aStatic = aSegs[i].length > 0 && !aSegs[i].startsWith(':')
    const bStatic = bSegs[i].length > 0 && !bSegs[i].startsWith(':')
    if (aStatic !== bStatic) return aStatic ? -1 : 1 // static outranks param
  }
  return 0
}

/** Number of segments in a path pattern that are NOT params (`:name`). */
function countStaticSegments(pattern: string): number {
  return pattern.split('/').filter((seg) => seg.length > 0 && !seg.startsWith(':')).length
}

/** Total number of non-empty segments in a path pattern. */
function countSegments(pattern: string): number {
  return pattern.split('/').filter((seg) => seg.length > 0).length
}

/**
 * Build a `(method, path) → OperationMeta | undefined` resolver from the registry.
 * Returns `undefined` for routes the model doesn't define (unknown routes), in
 * which case the pipeline runs only the generic, op-independent guards and lets
 * Hono 404.
 */
export function resolveOp(
  registry: OperationRegistry,
): (method: string, path: string) => PipelineOperationMeta | undefined {
  const compiled: CompiledRoute[] = Object.values(registry).map((meta) => ({
    method: meta.method.toUpperCase(),
    regex: compilePath(meta.path),
    meta,
    staticSegments: countStaticSegments(meta.path),
    totalSegments: countSegments(meta.path),
  }))
  // Order most-specific-first so resolveOp's first-match agrees with Hono's
  // router (AUTHZ-02): static segments outrank param segments, mirroring Hono's
  // static > param priority. Without this, registry insertion order could resolve
  // `/todos/search` to the `/todos/:id` param op when Hono dispatches the static
  // one. Sort by descending static-segment count, then by total segment count.
  compiled.sort((a, b) => {
    if (b.staticSegments !== a.staticSegments) return b.staticSegments - a.staticSegments
    if (b.totalSegments !== a.totalSegments) return b.totalSegments - a.totalSegments
    // Final tiebreaker: left-to-right per-segment static>param priority, so a
    // request matching two equally-"sized" patterns resolves to the same op Hono's
    // trie would dispatch (AUTHZ-02) rather than being decided by insertion order.
    return comparePerSegmentSpecificity(a.meta.path, b.meta.path)
  })
  return (method, path) => {
    const m = method.toUpperCase();
    // OPTIONS preflight has no operation of its own — it is handled by CORS.
    const match = compiled.find(
      (route) => route.method === m && route.regex.test(path),
    )
    return match?.meta
  }
}

/**
 * Return a copy of `registry` with every operation's `path` prefixed by
 * `basePath`, so a service mounted under a sub-path (e.g. `/api`) keeps the
 * registry in agreement with the live `c.req.path` the pipeline matches against
 * (see {@link resolveOp}). This is the canonical, reusable way to mount a
 * smithy-hono service under a prefix.
 *
 * WHY IT MATTERS: the pipeline resolves each request's operation by matching
 * `c.req.path` against the registry paths. `c.req.path` is the FULL pathname —
 * Hono's `.basePath('/api')` / `app.route('/api', sub)` do NOT strip it. So if
 * you mount the routes under `/api` but leave the registry saying `/notes`,
 * `resolveOp` returns `undefined` for `GET /api/notes`; the handler still runs,
 * but with NO operation, so its per-op auth / permission / CSRF / signature
 * checks are all skipped — the API silently becomes unauthenticated. Prefix the
 * registry with the SAME value you mount the routes under to keep them in sync.
 *
 * `basePath` should be empty or start with `/` and NOT end with `/`
 * (e.g. `''`, `/api`, `/v1/api`). An empty prefix returns the registry unchanged
 * (identity), so the default root-mounted posture is untouched.
 */
export function withBasePath<R extends OperationRegistry>(registry: R, basePath: string): R {
  if (basePath === '') return registry
  const out: OperationRegistry = {}
  for (const [name, meta] of Object.entries(registry)) {
    out[name] = { ...meta, path: basePath + meta.path }
  }
  return out as R
}

// All twelve canonical slots are now real implementations imported from their
// modules — no named pass-throughs remain. Slot 10 (verifySignature, S6) was the
// last placeholder; it landed once the ARCH-08 raw-body spike confirmed
// `readRawBody` (the verifier re-derives the body hash from the raw bytes).

// ---------------------------------------------------------------------------
// The factory.
// ---------------------------------------------------------------------------

/**
 * Compose the canonical pre-deserialization pipeline for a service. Returns the
 * ordered middleware array to mount at the app level:
 *
 * ```ts
 * const app = new Hono()
 * app.use('*', ...createSecurityPipeline(OPERATIONS, config))
 * app.route('/', createTodoRouter(ops, appMiddleware))
 * ```
 *
 * @param registry the codegen-emitted `OPERATIONS` map (registry.gen.ts)
 * @param config   the injected {@link SecurityConfig} (ARCH-05)
 */
export function createSecurityPipeline(
  registry: OperationRegistry,
  config: PipelineConfig,
): MiddlewareHandler[] {
  const resolve = resolveOp(registry)
  const stack: MiddlewareHandler[] = [
    requestId(), //                          1  S9
    structuredLogger(config), //             2  S9
    errorSanitizer(config), //               3  S9
    securityHeaders(config, resolve), //     4  S3
    assertHttps(config), //                  5  S3
    cors(config), //                         6  S8 (OPTIONS short-circuits here)
  ]

  // OPS-04 — DoS resistance, mounted AFTER cors (so a cheap OPTIONS preflight is
  // never shed/timed) and BEFORE the heavy phases. Both opt-in via config: a
  // load-shedder (RATE-05) sheds excess concurrency first, then a per-request
  // timeout (RATE-04) bounds the admitted request. Unset ⇒ omitted (no behavior).
  // When unset we emit a ONE-TIME construction-time warning (PIPELINE-MW-02),
  // mirroring the rate limiters' `ratelimit.disabled` passthrough signal, so a
  // zero-config deploy is no longer SILENT about relying on the platform runtime.
  if (config.maxInFlight !== undefined) {
    stack.push(loadShedder(config.maxInFlight))
  } else {
    config.logger?.warn({
      event: 'ops04.disabled',
      guard: 'loadShedder',
      message:
        'OPS-04 load-shedder is NOT mounted (config.maxInFlight unset); excess ' +
        'concurrency is bounded only by the platform runtime (e.g. Workers CPU ' +
        'limit, Lambda reserved concurrency). Set config.maxInFlight to enable it.',
    })
  }
  if (config.requestTimeoutMs !== undefined) {
    stack.push(withTimeout(config.requestTimeoutMs))
  } else {
    config.logger?.warn({
      event: 'ops04.disabled',
      guard: 'withTimeout',
      message:
        'OPS-04 request-timeout is NOT mounted (config.requestTimeoutMs unset); ' +
        'request duration is bounded only by the platform runtime (e.g. Lambda ' +
        'timeout). Set config.requestTimeoutMs to enable it.',
    })
  }

  stack.push(
    headerGuards(config, resolve), //        7a S4 (cheap header-only checks, pre-limiter)
    rateLimitPerIp(config, resolve), //      8  S7
    bodyGuards(config, resolve), //          7b S4 (buffer+decode+parse+walk, post-limiter)
    authenticate(config, resolve), //        9  S5  → sets c.get('principal')
    verifySignature(config, resolve), //    10  S6  (S2S ops only)
    csrf(config, resolve), //               11  S8  (cookie-auth only)
    rateLimitPerPrincipal(config, resolve), // 12 S7
  )
  return stack
}
