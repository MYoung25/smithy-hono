/**
 * Pipeline phase 2 — `structuredLogger` (S9, LOG-01/04).
 *
 * One structured line per request, emitted through the injected {@link Logger}
 * (ARCH-05): core never picks a transport (Workers console → Logpush, Lambda →
 * CloudWatch, Node → stdout JSON). It wraps the inner pipeline so the line is
 * written after the response status is known, with the request's correlation id
 * (set by {@link requestId}, phase 1) and a wall-clock duration.
 *
 * Web-standard only (ARCH-01): timing uses `Date.now()` (always available;
 * `performance.now()` is not guaranteed on every runtime) — no `node:*`, no
 * module-level env reads (ARCH-05).
 *
 * PII / secret hygiene (LOG-04): the record carries ONLY non-sensitive request
 * metadata (method, route template, status, duration) plus a pseudonymized
 * principal reference. It NEVER logs tokens, cookies, signatures, `Authorization`
 * headers, or request/response bodies.
 *
 * The logged `path` is the matched ROUTE TEMPLATE (`/notes/:id`), not the concrete
 * request path (`/notes/john@example.com`): an `@httpLabel` path parameter can
 * embed PII (email, account id, SSN), and logging the raw value would defeat the
 * principal pseudonymization on the same line. When no route matched, Hono reports
 * a non-PII sentinel template (`/*`), so an unmatched request never writes its raw
 * path either; the `|| c.req.path` fallback only applies if `routePath` is empty.
 *
 * TODO(@sensitive seam): the model's `@sensitive` trait identifies fields that
 * must be redacted from logs. When the registry exposes a per-operation
 * `sensitiveFields` summary, this logger should consult it to redact any field it
 * would otherwise emit. Today the record is a fixed, sensitive-field-free metadata
 * set, so nothing to redact yet — this is the documented hook for that follow-up.
 */

import type { MiddlewareHandler } from 'hono'
import type { SecurityConfig } from '../config.js'
import { principalRef } from '../audit/audit.js'
import { emitFiveXx } from '../audit/metrics.js'
import type { SecurityEnv } from './context.js'

/**
 * Phase 2 — emit one structured log line per request through `config.logger`,
 * plus the LOG-08 `http.5xx` operational signal through `config.metrics`.
 *
 * Two independent concerns share this seam because both need the response status,
 * known only after `next()`:
 *   - the structured request line (LOG-01/02) via `config.logger`, and
 *   - the per-5xx metric (LOG-08) via `config.metrics`.
 * This is the right place for the 5xx signal: it is the OUTERMOST observer of the
 * final status, so it counts every 5xx uniformly — a modeled 5xx, the
 * errorSanitizer's generic 500, and a platform 5xx alike — in one spot rather
 * than scattering counters through each error path.
 *
 * When BOTH `config.logger` and `config.metrics` are absent there is nothing to
 * do, so the factory returns a named pass-through and the pipeline shape is
 * unchanged. Otherwise it captures a start time, runs the inner pipeline, then
 * (when a logger is wired) logs `{ requestId, method, path, status, durationMs,
 * principal }` where `principal` is a pseudonymized reference (LOG-11) or `null`,
 * and (when the status is 5xx) emits an `http.5xx` signal.
 *
 * Every sink call is best-effort / guarded: a throwing logger or metrics sink
 * (bad transport, serialization error) must never break an otherwise-successful
 * request. The principal pseudonymization is likewise guarded.
 *
 * Typed on {@link SecurityEnv} so `c.get('requestId')` / `c.get('principal')` are
 * typed rather than `unknown`.
 */
export function structuredLogger(config: SecurityConfig): MiddlewareHandler<SecurityEnv> {
  const logger = config.logger
  const metrics = config.metrics
  if (!logger && !metrics) {
    // Nothing to observe — named pass-through keeps the pipeline shape inspectable.
    const passThrough: MiddlewareHandler<SecurityEnv> = async (_c, next) => {
      await next()
    }
    Object.defineProperty(passThrough, 'name', { value: 'structuredLogger' })
    return passThrough
  }

  const handler: MiddlewareHandler<SecurityEnv> = async (c, next) => {
    const start = Date.now()
    await next()

    const status = c.res.status
    // LOG-08: count every 5xx response (modeled, sanitized 500, or platform 5xx).
    // emitFiveXx is itself a no-op when `metrics` is undefined and never throws.
    if (status >= 500 && status <= 599) {
      emitFiveXx(metrics, { status }, logger)
    }

    if (!logger) return

    // Derive a pseudonymized principal reference (LOG-11) — never the raw id.
    // With a deployment salt set, use the keyed HMAC; absent one, route through the
    // NAMED insecure dev/test fallback rather than a silent bare hash, so the
    // unkeyed (correlatable/reversible) choice is explicit at the wiring layer.
    let principal: string | null = null
    try {
      const p = c.get('principal')
      if (p) {
        // Use the SHARED principalRef helper so this request-log ref uses the exact
        // same salt-presence rule as the audit-event sites — an empty-string
        // auditSalt routes to defaultPseudonymize, not HMAC('') (LOG-11 correlation).
        principal = await principalRef(p.id, config.auditSalt)
      }
    } catch {
      // Pseudonymization failure must not break the request; log without it.
      principal = null
    }

    try {
      logger.info({
        requestId: c.get('requestId'),
        method: c.req.method,
        // Route TEMPLATE, not the concrete path: an `@httpLabel` value can be PII.
        // Hono reports '/*' for an unmatched route (also non-PII); the raw-path
        // fallback only applies if routePath is somehow empty.
        path: c.req.routePath || c.req.path,
        status,
        durationMs: Date.now() - start,
        principal,
      })
    } catch {
      // Best-effort logging: a logger throw must never break the request.
    }
  }
  Object.defineProperty(handler, 'name', { value: 'structuredLogger' })
  return handler
}
