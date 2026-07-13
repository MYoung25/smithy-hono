/**
 * Phase S7 — rate limiting & DoS resistance (RATE-01..RATE-07).
 *
 * Two token-bucket limiters mounted in the canonical pipeline, plus three
 * standalone DoS-resistance primitives the app mounts/calls where needed:
 *
 *   - {@link rateLimitPerIp}        — pipeline slot 8 (pre-auth, coarse, keyed on
 *     client IP). Protects unauthenticated endpoints (RATE-01).
 *   - {@link rateLimitPerPrincipal} — pipeline slot 12 (post-auth, keyed on
 *     `principal.id`). The main quota for authenticated traffic (RATE-01).
 *   - {@link authRateLimit}         — RATE-03 brute-force helper for auth routes.
 *   - {@link withTimeout}           — RATE-04 total-processing timeout (optional).
 *   - {@link loadShedder}           — RATE-05 in-flight load-shedder (optional).
 *
 * Web-standard only (ARCH-01): everything is driven off the Hono `Context`, the
 * injected {@link SecurityConfig}, the per-request {@link PipelineOperationMeta}
 * from the registry resolver, and the strongly-consistent {@link RateLimitStore}
 * — no `node:*`, no `Buffer`, no module-level env reads (ARCH-05).
 *
 * Breaches return the Smithy-modeled `ThrottlingException` body (429) plus an
 * integer `Retry-After` header (RATE-02) so generated clients retry correctly.
 *
 * RATE-06 (pagination caps) is NOT enforced here — it is already enforced by the
 * generated Zod `@range` max from Phase S1 at deserialization time; nothing to do.
 */

import type { Context, MiddlewareHandler } from 'hono'
import type { SecurityConfig } from '../config.js'
import type {
  RateDecision,
  RateLimitStore,
  TokenBucketSpec,
} from '../storage/index.js'
import { buildAuditEvent, emitAudit, principalRef } from '../audit/audit.js'
import { emitRateLimitSaturation } from '../audit/metrics.js'
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
 * Rate-limit adapter hook (ARCH-01). The real client IP lives in a
 * platform-specific header — `CF-Connecting-IP` (Workers), `X-Forwarded-For`
 * (ALB/ingress, leftmost trusted hop), API Gateway request context (Lambda) — so
 * core never hardcodes it; the adapter (`adapter-{cf,aws,node}`, Phase S10)
 * supplies the resolver. Mirrors {@link TransportConfig.forwardedProtoHeader}.
 */
export interface RateLimitConfig {
  /** Returns the effective client IP used as the per-IP limiter key. */
  clientIp(c: Context): string
  /**
   * Per-request timeout in ms (RATE-04, OPS-04). When set, the pipeline races the
   * downstream handler against this deadline and returns 504 on overrun. Off when
   * unset (no timeout).
   */
  requestTimeoutMs?: number
  /**
   * Max concurrent in-flight requests (RATE-05, OPS-04). When set, the pipeline
   * sheds excess load with 503. Off when unset (no shedding).
   */
  maxInFlight?: number
}

/** The config both limiter factories read — `SecurityConfig` plus this hook. */
type LimiterConfig = SecurityConfig & RateLimitConfig

// ---------------------------------------------------------------------------
// Shared 429 ThrottlingException (RATE-02).
// ---------------------------------------------------------------------------

/**
 * Emit the modeled `ThrottlingException` (RATE-02): a 429 with the integer
 * `Retry-After` header so generated clients back off and retry correctly. The
 * header MUST be whole seconds (HTTP `Retry-After` is integer-valued), so the
 * store's `retryAfterSeconds` is ceiled.
 */
function throttle(c: Context, d: RateDecision): Response {
  c.header('Retry-After', String(Math.ceil(d.retryAfterSeconds)))
  return c.json({ code: 'ThrottlingException', message: 'Too Many Requests' }, 429)
}

/**
 * Build a named pass-through (limiter off — graceful when the store/spec is
 * absent). A disabled limiter slot is wide-open by design, so we make it LOUD:
 * emit a ONE-TIME construction-time warning via the injected logger (RT-07) so a
 * silently-unthrottled deployment is visible in the logs. We do NOT change the
 * pass-through behavior itself — apps that intentionally run without rate limits
 * keep working; they are simply no longer SILENT about it.
 */
function passthrough(
  name: string,
  config: LimiterConfig,
  reason: string,
): MiddlewareHandler {
  config.logger?.warn({
    event: 'ratelimit.disabled',
    limiter: name,
    reason,
    message:
      `${name} is MOUNTED but DISABLED (${reason}); requests pass through ` +
      'unthrottled. Wire stores.rateLimit and the matching rateLimits spec to ' +
      'enable it, or remove the slot if this is intentional.',
  })
  const handler: MiddlewareHandler = async (_c, next) => {
    await next()
  }
  Object.defineProperty(handler, 'name', { value: name })
  return handler
}

/** Describe WHY a limiter slot is disabled, for the one-time warning. */
function disabledReason(hasStore: boolean, hasSpec: boolean): string {
  if (!hasStore && !hasSpec) return 'no stores.rateLimit backend and no spec configured'
  if (!hasStore) return 'no stores.rateLimit backend configured'
  return 'no rate-limit spec configured'
}

// ---------------------------------------------------------------------------
// rateLimitPerIp — pipeline slot 8 (coarse, pre-auth).
// ---------------------------------------------------------------------------

/**
 * Slot 8 — coarse per-IP limiter, mounted BEFORE auth so it protects
 * unauthenticated endpoints (RATE-01). Keyed on the adapter-resolved client IP
 * (`ip:<clientIp>`), so each source IP gets an independent bucket.
 *
 * Graceful-off: when no `stores.rateLimit` backend is wired OR `rateLimits.perIp`
 * is unset, returns a named pass-through (limiting off — matches the "absent when
 * limiting is off" config convention; the integrator can always mount the slot).
 *
 * Per-request: resolves the op, charges `op.cost` tokens (RATE-07; default 1 for
 * unknown routes), and on `!allowed` returns the modeled `ThrottlingException`
 * (RATE-02) with an integer `Retry-After`.
 */
export function rateLimitPerIp(
  config: LimiterConfig,
  resolve: OpResolver,
): MiddlewareHandler {
  const store = config.stores.rateLimit
  const spec = config.rateLimits?.perIp
  if (!store || !spec) {
    return passthrough('rateLimitPerIp', config, disabledReason(!!store, !!spec))
  }

  const handler: MiddlewareHandler = async (c, next) => {
    const op = resolve(c.req.method, c.req.path)
    const cost = op?.cost ?? 1 // RATE-07 — per-op @cost feeds the bucket.
    const key = `ip:${config.clientIp(c)}`
    const d = await store.consume(key, cost, spec)
    if (!d.allowed) {
      // LOG-10 at-source: emit `ratelimit.trip` the moment the bucket denies.
      // Pre-auth, so there is no principal yet (principalRef null); the raw IP is
      // NOT placed in the event (PII) — only the scope + back-off are recorded.
      await emitAudit(
        config.audit,
        buildAuditEvent({
          type: 'ratelimit.trip',
          requestId: (c.get('requestId') as string | undefined) ?? '',
          principalRef: null,
          operation: op?.name,
          outcome: 'deny',
          detail: { scope: 'ip', retryAfterSeconds: Math.ceil(d.retryAfterSeconds) },
        }),
        config.logger,
      )
      // LOG-08 operational signal: this bucket is saturated. Countable/alertable
      // separately from the audit record; carries no raw IP (LOG-06).
      emitRateLimitSaturation(
        config.metrics,
        { scope: 'ip', operation: op?.name, retryAfterSeconds: Math.ceil(d.retryAfterSeconds) },
        config.logger,
      )
      return throttle(c, d)
    }
    await next()
  }
  Object.defineProperty(handler, 'name', { value: 'rateLimitPerIp' })
  return handler
}

// ---------------------------------------------------------------------------
// rateLimitPerPrincipal — pipeline slot 12 (post-auth).
// ---------------------------------------------------------------------------

/**
 * Slot 12 — per-principal limiter, mounted AFTER auth: the main quota for
 * authenticated traffic (RATE-01). Keyed on `pr:<principal.id>` from the
 * principal `authenticate` (S5) / `verifySignature` (S6) set on the context.
 *
 * Graceful-off: when no `stores.rateLimit` backend is wired OR
 * `rateLimits.perPrincipal` is unset, returns a named pass-through.
 *
 * Anonymous bypass: a request with no principal (an anonymous op, or one where
 * auth set none) is `next()`-ed through — anonymous traffic is already covered by
 * the per-IP limiter (slot 8), so double-counting it here would be wrong.
 */
export function rateLimitPerPrincipal(
  config: LimiterConfig,
  resolve: OpResolver,
): MiddlewareHandler {
  const store = config.stores.rateLimit
  const spec = config.rateLimits?.perPrincipal
  if (!store || !spec) {
    return passthrough('rateLimitPerPrincipal', config, disabledReason(!!store, !!spec))
  }

  const handler: MiddlewareHandler = async (c, next) => {
    const principal = c.get('principal')
    // No principal → anonymous traffic, covered by the per-IP limiter (slot 8).
    if (!principal) {
      await next()
      return
    }
    const op = resolve(c.req.method, c.req.path)
    const cost = op?.cost ?? 1 // RATE-07.
    const key = `pr:${principal.id}`
    const d = await store.consume(key, cost, spec)
    if (!d.allowed) {
      // LOG-10 at-source: emit `ratelimit.trip` keyed to the pseudonymized
      // principal (LOG-11 — never the raw id) the moment the bucket denies.
      await emitAudit(
        config.audit,
        buildAuditEvent({
          type: 'ratelimit.trip',
          requestId: (c.get('requestId') as string | undefined) ?? '',
          principalRef: await principalRef(principal.id, config.auditSalt),
          operation: op?.name,
          outcome: 'deny',
          detail: { scope: 'principal', retryAfterSeconds: Math.ceil(d.retryAfterSeconds) },
        }),
        config.logger,
      )
      // LOG-08 operational signal: principal bucket saturated. No raw principal id
      // (LOG-06) — only the scope/op/back-off.
      emitRateLimitSaturation(
        config.metrics,
        { scope: 'principal', operation: op?.name, retryAfterSeconds: Math.ceil(d.retryAfterSeconds) },
        config.logger,
      )
      return throttle(c, d)
    }
    await next()
  }
  Object.defineProperty(handler, 'name', { value: 'rateLimitPerPrincipal' })
  return handler
}

// ---------------------------------------------------------------------------
// authRateLimit — RATE-03 brute-force / account-lockout helper.
// ---------------------------------------------------------------------------

/**
 * RATE-03 — auth-endpoint brute-force defense. A thin helper the app's
 * OIDC-callback / token route calls BEFORE verifying credentials, keyed on the
 * *attempted subject* (e.g. `authfail:<subject>`), to lock out credential
 * stuffing / password spraying against a single account.
 *
 * Exponential-backoff lockout is achieved purely by configuration: pass a
 * low-`capacity`, slow-`refillPerSecond` {@link TokenBucketSpec} so a handful of
 * failed attempts drain the bucket and each subsequent attempt sees a longer
 * `retryAfterSeconds` until tokens accrue again. This helper only returns the
 * decision; the caller is responsible for rejecting (e.g. 429
 * `ThrottlingException` with `Retry-After`) when `!allowed`, and SHOULD consume
 * against this bucket on a *failed* credential check so successful logins are not
 * penalized.
 *
 * @param store   the strongly-consistent {@link RateLimitStore} (no cross-isolate overspend).
 * @param subject the attempted subject/account identifier (already namespaced by the caller).
 * @param spec    the (deliberately strict) token-bucket spec for auth attempts.
 */
export async function authRateLimit(
  store: RateLimitStore,
  subject: string,
  spec: TokenBucketSpec,
): Promise<RateDecision> {
  return store.consume(subject, 1, spec)
}

// ---------------------------------------------------------------------------
// withTimeout — RATE-04 total-processing timeout (optional middleware).
// ---------------------------------------------------------------------------

/**
 * RATE-04 — bound total processing time. Races `next()` against an `ms` timer; if
 * the timer wins, responds `504 RequestTimeout` instead of waiting indefinitely.
 *
 * ⚠️ JS LIMITATION: this bounds *when a response is sent*, NOT the in-flight work.
 * Standard JavaScript has no preemptive cancellation — the downstream handler
 * keeps executing (and consuming CPU / store round-trips) in the background even
 * after the 504 is returned; its eventual result is simply discarded. The real
 * ceiling on resource use is the platform/runtime timeout (Cloudflare Workers CPU
 * limit, Lambda function timeout), which CAN terminate the work. Treat this
 * middleware as a fast-fail UX guard, not a resource cap.
 *
 * OPTIONAL: this is NOT part of the canonical 12-slot pipeline; the app mounts it
 * (e.g. `app.use('*', withTimeout(10_000))`) where it wants a soft response cap.
 */
export function withTimeout(ms: number): MiddlewareHandler {
  const handler: MiddlewareHandler = async (c, next) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms)
    })
    try {
      const outcome = await Promise.race([next().then(() => 'done' as const), timeout])
      if (outcome === 'timeout') {
        // The handler is still running in the background (no true cancellation).
        return c.json({ code: 'RequestTimeout', message: 'Request timed out' }, 504)
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  Object.defineProperty(handler, 'name', { value: 'withTimeout' })
  return handler
}

// ---------------------------------------------------------------------------
// loadShedder — RATE-05 in-flight load-shedding (optional middleware).
// ---------------------------------------------------------------------------

/**
 * RATE-05 — shed load early with `503 ServiceUnavailable` once `maxInFlight`
 * requests are concurrently in flight, decrementing in a `finally` so a slot is
 * always released. Cheaper than letting every request pile onto the handler/store.
 *
 * ⚠️ ARCH-02 — LOCAL FLOOR, NOT GLOBAL: the counter is closure-local, so it counts
 * only requests in *this* isolate/container. On Workers/Lambda there are many
 * isolates, so the effective global concurrency is `maxInFlight × instanceCount`,
 * not `maxInFlight`. Accurate global concurrency limiting needs platform-native
 * limits (Workers/queue concurrency, Lambda reserved concurrency); this is a
 * best-effort *local* floor only. This closure-local counter is the one accepted
 * exception to "no in-memory cross-request state" (ARCH-02) precisely because it
 * is explicitly local and best-effort — it carries no consistency guarantee.
 *
 * OPTIONAL: NOT part of the canonical 12-slot pipeline; the app mounts it.
 */
export function loadShedder(maxInFlight: number): MiddlewareHandler {
  let inFlight = 0 // ARCH-02 exception: explicitly a local, best-effort floor.
  const handler: MiddlewareHandler = async (c, next) => {
    if (inFlight >= maxInFlight) {
      return c.json({ code: 'ServiceUnavailable', message: 'Server busy' }, 503)
    }
    inFlight++
    try {
      await next()
    } finally {
      inFlight--
    }
  }
  Object.defineProperty(handler, 'name', { value: 'loadShedder' })
  return handler
}
