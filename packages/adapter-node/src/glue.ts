/**
 * Node/reverse-proxy platform glue: the forwarded-proto resolver, the client-IP
 * resolver, and the stdout JSON logger sink. These satisfy the adapter hooks
 * security-core's pipeline expects — `TransportConfig.forwardedProtoHeader`,
 * `RateLimitConfig.clientIp`, and the `Logger` sink — for a Node service sitting
 * behind a reverse proxy / load balancer (ALB, nginx, k8s ingress).
 *
 * Web-standard only: everything is driven off Hono's `Context` request headers;
 * the logger is the one place that touches Node stdout (via `console.log`).
 */

import type { Context } from 'hono'
import type { Logger } from '@smithy-hono/security-core'

// ---------------------------------------------------------------------------
// forwarded-proto resolver (TLS-03).
// ---------------------------------------------------------------------------

/**
 * Read the effective request scheme from `X-Forwarded-Proto` (the header a Node
 * reverse proxy / LB sets, e.g. `https`). Returns the lowercased first value, or
 * `undefined` when absent — `assertHttps` treats anything but `'https'` as
 * plaintext and rejects (TLS-03), so absence fails closed.
 *
 * ⚠️ TRUST BOUNDARY: `X-Forwarded-Proto` is client-spoofable unless the request
 * actually traversed a trusted proxy that overwrites it. Only mount `assertHttps`
 * with this resolver when the service is reachable ONLY through such a proxy
 * (terminate TLS there and have it set the header); a directly-exposed Node
 * process must not trust it.
 */
export function forwardedProtoHeader(c: Context): string | undefined {
  const raw = c.req.header('x-forwarded-proto')
  if (raw === undefined) return undefined
  // A proxy chain may produce a comma list; the leftmost is the original client edge.
  const first = raw.split(',')[0]?.trim().toLowerCase()
  return first === '' ? undefined : first
}

// ---------------------------------------------------------------------------
// client-IP resolver (RATE-01).
// ---------------------------------------------------------------------------

/** Options for {@link clientIp}. */
export interface ClientIpOptions {
  /**
   * Number of trusted proxy hops at the right edge of `X-Forwarded-For`. The
   * resolver returns the entry `trustedHops` positions from the RIGHT (the IP
   * the outermost trusted proxy observed). Default `0` → take the leftmost entry
   * (assumes the whole chain is trusted / a single trusted proxy).
   */
  trustedHops?: number
  /** Fallback key when no XFF header is present. Default `'unknown'`. */
  fallback?: string
}

/**
 * Resolve the client IP used as the per-IP rate-limit key from
 * `X-Forwarded-For`.
 *
 * ⚠️ TRUSTED-HOP ASSUMPTION: `X-Forwarded-For` is a client-controllable,
 * comma-separated chain `client, proxy1, proxy2`. Every value to the LEFT of a
 * trusted proxy can be forged by the client, so you can only trust entries
 * appended by proxies you control. By default this takes the **leftmost** entry,
 * which is correct ONLY when a single trusted proxy (that overwrites/owns XFF)
 * fronts the service. Behind N trusted proxies, set `trustedHops: N` to take the
 * entry the outermost trusted hop saw, instead of an attacker-supplied leftmost
 * value. A directly-exposed Node process must NOT trust XFF at all (set up a
 * proxy first). With no header we fall back to a constant key (default
 * `'unknown'`) — a coarse shared bucket — rather than failing open.
 */
export function clientIp(c: Context, opts: ClientIpOptions = {}): string {
  const raw = c.req.header('x-forwarded-for')
  const fallback = opts.fallback ?? 'unknown'
  if (raw === undefined) return fallback
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (parts.length === 0) return fallback

  const hops = opts.trustedHops ?? 0
  if (hops <= 0) {
    // Single trusted proxy: the leftmost entry is the real client.
    return parts[0]!
  }
  // Behind `hops` trusted proxies: take the entry that many positions from the
  // right (clamped into range), which the outermost trusted hop observed. This
  // matches awsClientIp's `length - fromRight` indexing.
  const idx = Math.max(0, parts.length - hops)
  return parts[idx]!
}

/**
 * Curry {@link clientIp} into the `(c) => string` shape `RateLimitConfig.clientIp`
 * expects, binding the trusted-hop options once.
 */
export function clientIpResolver(opts: ClientIpOptions = {}): (c: Context) => string {
  return (c) => clientIp(c, opts)
}

// ---------------------------------------------------------------------------
// stdout JSON logger sink (LOG-01).
// ---------------------------------------------------------------------------

/** Minimal structural console (no @types/node; `console.log` is ambient via DOM lib). */
interface ConsoleLike {
  log(line: string): void
  error(line: string): void
}

declare const console: ConsoleLike

export interface StdoutLoggerOptions {
  /** Static fields merged into every line (e.g. `{ service: 'todo-api' }`). */
  base?: Record<string, unknown>
}

/**
 * Create a {@link Logger} that emits ONE JSON line per record to stdout via
 * `console.log(JSON.stringify(...))` — the Node convention where a log shipper
 * (Fluent Bit / Vector / the container runtime) tails stdout and forwards
 * structured lines. `error` records go to stderr (`console.error`). A `level`
 * and ISO `ts` are added; core only ever passes sanitized, PII-free records
 * (LOG-01/11), so the whole record is safe to serialize.
 */
export function createStdoutLogger(opts: StdoutLoggerOptions = {}): Logger {
  const base = opts.base ?? {}
  const emit = (
    level: 'info' | 'warn' | 'error',
    record: Record<string, unknown>,
  ): void => {
    const line = JSON.stringify({ level, ts: new Date().toISOString(), ...base, ...record })
    if (level === 'error') console.error(line)
    else console.log(line)
  }
  return {
    info: (record) => emit('info', record),
    warn: (record) => emit('warn', record),
    error: (record) => emit('error', record),
  }
}
