/**
 * Pipeline phase 3 — `errorSanitizer` (S9, HDR-05).
 *
 * The catch-all that guarantees internal error detail NEVER reaches the client.
 * It wraps the inner pipeline in a try/catch and maps anything thrown to a safe
 * JSON response carrying the request's correlation id (set by `requestId`, phase
 * 1) so a client-visible failure can be traced to its log line without leaking
 * internals.
 *
 * This COMPLEMENTS the per-route try/catch already generated in `*.gen.ts`, which
 * discriminates modeled errors via the generated `errors.ts`. This middleware is
 * the BACKSTOP: it catches what the route catch misses — throws from middleware
 * (which run outside any route handler), and unmodeled/unexpected errors.
 *
 * Two interception points are needed because of how Hono propagates errors. A
 * throw from a sibling/inner MIDDLEWARE propagates up through `await next()`, so a
 * try/catch handles it. A throw from a ROUTE HANDLER, however, is caught by Hono's
 * per-route error boundary (it wraps each handler in `compose([], app.errorHandler)`)
 * and converted to a response *before* it reaches outer middleware — `next()`
 * resolves normally with `c.error` set. We therefore ALSO inspect `c.error` after
 * `next()` and re-sanitize, so an unmodeled handler throw never escapes as Hono's
 * default (un-sanitized) 500. Both paths funnel through {@link sanitizeError}.
 *
 * Core CANNOT import generated code (parallel-safety, no dependency on a service's
 * `errors.ts`), so "modeled" is decided by STRUCTURAL duck-typing (ARCH-01): a
 * thrown value is treated as a modeled Smithy error when it carries a finite
 * numeric `$statusCode` and a string `name`. Everything else is unmodeled → a
 * generic 500 with the detail sent to LOGS ONLY.
 *
 * Web-standard only (ARCH-01): no `node:*`, no module-level env reads (ARCH-05).
 */

import type { Context, MiddlewareHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { SecurityConfig } from '../config.js'
import { REDACTED } from '../audit/redact.js'
import type { SecurityEnv } from './context.js'

/** The structural shape of a modeled Smithy error, as recognized at runtime. */
export interface ModeledError {
  name: string
  message?: string
  $statusCode: number
  code?: string
}

/**
 * Brand stamped on every generated modeled error (the `SmithyError` base sets it in
 * its constructor). Resolved from the GLOBAL symbol registry so it matches across
 * the security-core ↔ generated-code module boundary without importing the
 * generated `errors.ts` (keeping core decoupled). RT-08.
 */
const MODELED_ERROR_BRAND = Symbol.for('@smithy-hono/security-core/modeled-error')

/**
 * Test for a genuinely-modeled error (HDR-05, RT-08). Requires the generated-error
 * BRAND (not just a structural `$statusCode`): a library/internal error that merely
 * happens to carry a numeric `$statusCode` is NOT modeled, so its `message` is never
 * reflected to the client. Still validates `$statusCode` is a finite number (used as
 * the response status) and `name` is a string (the fallback `code`).
 */
export function isModeledError(e: unknown): e is ModeledError {
  if (e === null || typeof e !== 'object') return false
  if ((e as Record<symbol, unknown>)[MODELED_ERROR_BRAND] !== true) return false
  const obj = e as Record<string, unknown>
  return (
    typeof obj['$statusCode'] === 'number' &&
    Number.isFinite(obj['$statusCode']) &&
    typeof obj['name'] === 'string'
  )
}

/**
 * Best-effort secret-scrubbing patterns applied to free-form error text before it
 * reaches the log sink. An arbitrary thrown `Error`'s `message`/`stack` can embed
 * submitted values, driver errors with query params, or token fragments, so it is
 * NOT PII/secret-free in general — but it has no field paths, so the path-based
 * `redactSensitive` cannot scrub it. This regex pass is a heuristic backstop that
 * masks the common credential shapes, satisfying the `Logger` "PII-free records"
 * contract for the unmodeled-error path (a hardening measure, not a guarantee).
 */
const SECRET_PATTERNS: readonly { re: RegExp; replacement: string }[] = [
  // `Bearer <token>` authorization values — mask the whole match.
  { re: /\bBearer\s+[\w._~+/-]+=*/gi, replacement: REDACTED },
  // JWT-shaped strings (three base64url segments) — mask the whole match.
  { re: /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, replacement: REDACTED },
  // `key=value` / `key: value` for secret-bearing key names — keep the
  // `key=` prefix (group 1), mask the value (group 2).
  {
    re: /\b((?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|authorization|cookie|session)\b\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
    replacement: `$1${REDACTED}`,
  },
  // Connection-string credentials (`scheme://user:pass@host`) — keep the scheme
  // prefix (group 1), mask the `user:pass` credentials.
  { re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s:@/]+@/gi, replacement: `$1${REDACTED}@` },
]

/** Maximum kept length of a scrubbed `message`/`stack` string (caps bulk leakage). */
const MAX_LOG_TEXT_LEN = 4096

/** Mask known secret shapes in free-form error text, then bound its length. */
function scrubErrorText(text: string): string {
  let out = text
  for (const { re, replacement } of SECRET_PATTERNS) {
    out = out.replace(re, replacement)
  }
  return out.length > MAX_LOG_TEXT_LEN ? `${out.slice(0, MAX_LOG_TEXT_LEN)}…[truncated]` : out
}

/**
 * Extract a safe, structured summary of a thrown value for LOG output only —
 * name/message/stack when it is an `Error`, a best-effort string otherwise (a
 * non-Error throw, e.g. `throw 'boom'` or a thrown object). The `message`/`stack`
 * are run through {@link scrubErrorText} so common credential shapes are masked
 * before they reach the log sink. This detail is NEVER returned to the client.
 */
export function serializeForLog(e: unknown): Record<string, unknown> {
  if (e instanceof Error) {
    return {
      name: e.name,
      message: scrubErrorText(e.message),
      stack: e.stack === undefined ? undefined : scrubErrorText(e.stack),
    }
  }
  if (e !== null && typeof e === 'object') {
    // A thrown plain object — capture it shallowly without assuming Error shape.
    return { name: 'NonError', value: scrubErrorText(safeToString(e)) }
  }
  return { name: 'NonError', value: scrubErrorText(safeToString(e)) }
}

/** Best-effort string form of an arbitrary thrown value, never throwing itself. */
function safeToString(e: unknown): string {
  try {
    if (typeof e === 'object') return JSON.stringify(e)
    return String(e)
  } catch {
    return Object.prototype.toString.call(e)
  }
}

/**
 * Phase 3 — sanitize errors escaping the inner pipeline (HDR-05).
 *
 * - Modeled error (structural `$statusCode`) → `{ code, message, requestId }` at
 *   its `$statusCode`. `code` prefers the error's `code`, falling back to `name`.
 * - Unmodeled error → full detail to `config.logger.error` (logs only), and a
 *   sanitized generic `500 InternalServerError` to the client. No stack, no
 *   internal message, ever crosses to the response body.
 *
 * Typed on {@link SecurityEnv} so `c.get('requestId')` is typed.
 */
export function errorSanitizer(config: SecurityConfig): MiddlewareHandler<SecurityEnv> {
  /** Map a thrown value to its safe response, logging unmodeled detail. */
  const sanitizeError = (c: Context<SecurityEnv>, e: unknown): Response => {
    const requestId = c.get('requestId')

    if (isModeledError(e)) {
      // Pass the modeled error through in the safe public shape.
      return c.json(
        { code: e.code ?? e.name, message: e.message, requestId },
        e.$statusCode as ContentfulStatusCode,
      )
    }

    // Unmodeled — full detail to logs only; generic, leak-free body to client.
    config.logger?.error({ requestId, err: serializeForLog(e) })
    return c.json(
      { code: 'InternalServerError', message: 'Internal server error', requestId },
      500,
    )
  }

  const handler: MiddlewareHandler<SecurityEnv> = async (c, next) => {
    try {
      await next()
    } catch (e) {
      // A throw that propagated up from inner MIDDLEWARE (outside any route
      // handler's error boundary).
      return sanitizeError(c, e)
    }

    // A ROUTE HANDLER throw is caught by Hono's per-route boundary, which sets
    // `c.error` and finalizes a default 500. Re-sanitize so internals never leak.
    // We must ASSIGN `c.res` (not `return`): the response is already finalized at
    // this depth, so a returned Response would be discarded by `compose`.
    if (c.error !== undefined) {
      c.res = sanitizeError(c, c.error)
    }
  }
  Object.defineProperty(handler, 'name', { value: 'errorSanitizer' })
  return handler
}
