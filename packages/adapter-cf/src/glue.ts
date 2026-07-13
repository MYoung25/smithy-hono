/**
 * Cloudflare platform glue — the concrete adapter hooks the security-core
 * pipeline reads (ARCH-01). Each is a pure function of the Hono `Context`'s
 * request headers, so they are trivially unit-testable with a plain `Context`.
 *
 *   - {@link forwardedProtoHeader} satisfies `TransportConfig.forwardedProtoHeader`
 *     (pipeline/headers.ts) — Cloudflare's `CF-Visitor` JSON, falling back to
 *     `X-Forwarded-Proto`.
 *   - {@link clientIp} satisfies `RateLimitConfig.clientIp` (pipeline/rateLimit.ts)
 *     — Cloudflare's `CF-Connecting-IP`.
 *   - {@link createConsoleLogger} provides a `Logger` emitting one JSON line per
 *     record via `console.{info,warn,error}` → Workers Logpush.
 */

import type { Context } from 'hono'
import type { Logger } from '@smithy-hono/security-core'

// ---------------------------------------------------------------------------
// forwarded-proto — TransportConfig.forwardedProtoHeader
// ---------------------------------------------------------------------------

/**
 * Resolve the client's effective scheme on Cloudflare.
 *
 * Primary source is the `CF-Visitor` header, a JSON object Cloudflare injects,
 * e.g. `{"scheme":"https"}`, describing the scheme of the ORIGINAL client→edge
 * connection (the Worker↔origin hop may differ). Falls back to
 * `X-Forwarded-Proto` (taking the leftmost value) when `CF-Visitor` is absent or
 * unparseable, and returns `undefined` if neither is present so the caller's
 * `!== 'https'` check fails closed (TLS-03).
 */
export function forwardedProtoHeader(c: Context): string | undefined {
  const cfVisitor = c.req.header('cf-visitor')
  if (cfVisitor) {
    try {
      const parsed = JSON.parse(cfVisitor) as { scheme?: unknown }
      if (typeof parsed.scheme === 'string' && parsed.scheme.length > 0) {
        return parsed.scheme.toLowerCase()
      }
    } catch {
      // Malformed CF-Visitor → fall through to X-Forwarded-Proto.
    }
  }
  const xfp = c.req.header('x-forwarded-proto')
  if (xfp) {
    // May be a comma list (proxied chain); the leftmost is the client-facing hop.
    const first = xfp.split(',')[0]?.trim().toLowerCase()
    if (first) return first
  }
  return undefined
}

// ---------------------------------------------------------------------------
// client IP — RateLimitConfig.clientIp
// ---------------------------------------------------------------------------

/**
 * The real client IP on Cloudflare: the `CF-Connecting-IP` header Cloudflare sets
 * (spoof-resistant — it is rewritten at the edge regardless of any client-supplied
 * value). Returns `'unknown'` if absent so the limiter still produces a stable
 * (shared) bucket key rather than throwing.
 */
export function clientIp(c: Context): string {
  return c.req.header('cf-connecting-ip') ?? 'unknown'
}

// ---------------------------------------------------------------------------
// logger — Logger over console → Logpush
// ---------------------------------------------------------------------------

/**
 * A {@link Logger} that emits one JSON object per record via the matching
 * `console` method. On Workers these lines are captured by Logpush; the structured
 * JSON keeps them queryable. A `level` field is added so a single Logpush stream
 * stays filterable. Core only ever passes sanitized, PII-free records (LOG-01/11).
 */
export function createConsoleLogger(): Logger {
  const emit = (
    level: 'info' | 'warn' | 'error',
    record: Record<string, unknown>,
  ): void => {
    const line = JSON.stringify({ level, ...record })
    if (level === 'info') console.info(line)
    else if (level === 'warn') console.warn(line)
    else console.error(line)
  }
  return {
    info: (record) => emit('info', record),
    warn: (record) => emit('warn', record),
    error: (record) => emit('error', record),
  }
}
