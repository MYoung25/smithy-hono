/**
 * AWS platform glue for the security-core pipeline (ARCH-01):
 *   - {@link awsForwardedProto}  → satisfies `TransportConfig.forwardedProtoHeader`
 *   - {@link awsClientIp}        → satisfies `RateLimitConfig.clientIp`
 *   - {@link createConsoleLogger}→ satisfies the core `Logger` (→ CloudWatch)
 *
 * These read off the Hono `Context` only — no `node:*`, no env reads. They are
 * plain functions/factories the service folds into its injected SecurityConfig.
 */

import type { Context } from 'hono'
import type { Logger } from '@smithy-hono/security-core'

// ---------------------------------------------------------------------------
// Lambda request context (the `hono/aws-lambda` adapter binds the raw event to
// `c.env`, so the AWS-attested source IP lives on `event.requestContext`). This
// is the only client identity that is NOT client-spoofable, regardless of edge.
// ---------------------------------------------------------------------------

/** API Gateway v2 / Function URL / ALB shape: `requestContext.http.sourceIp`. */
interface RequestContextV2 {
  http?: { sourceIp?: string }
}
/** API Gateway v1 (REST) shape: `requestContext.identity.sourceIp`. */
interface RequestContextV1 {
  identity?: { sourceIp?: string }
}

/** Read the AWS-attested source IP from the Lambda event request context. */
function requestContextSourceIp(c: Context): string | undefined {
  const rc = (c.env as { requestContext?: RequestContextV1 & RequestContextV2 } | undefined)
    ?.requestContext
  if (!rc) return undefined
  // v2 / HTTP API / Function URL / ALB expose it under `http`; v1 under `identity`.
  return rc.http?.sourceIp ?? rc.identity?.sourceIp ?? undefined
}

// ---------------------------------------------------------------------------
// forwarded-proto (TLS-03)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective request scheme behind AWS edges.
 *
 * ALB and API Gateway REST set `X-Forwarded-Proto`; we read it (lowercased)
 * directly off the request headers — the default, zero-config path.
 *
 * SECURITY: `X-Forwarded-Proto` is client-supplied and therefore spoofable
 * UNLESS a trusted edge (ALB / API Gateway / CloudFront) overwrites it. Behind a
 * bare Lambda Function URL there is no such edge, so this header lets a client
 * forge `https` and bypass `assertHttps`. Pass `{ trustEdge: false }` (the
 * hardened default the sample handler uses) to ignore the header entirely and
 * report `https` — correct because a Function URL is HTTPS-only at the transport
 * layer — falling closed to `undefined` only if the request context is missing.
 *
 * CAVEAT — API Gateway HTTP API (payload v2.0): the scheme can instead arrive in
 * the request context (`requestContext.http.protocol` / the `cloudfront-forwarded-proto`
 * header), NOT always as `X-Forwarded-Proto`. If your integration is one of
 * those, pass `{ headerName }` to read an alternate header, e.g.
 * `awsForwardedProto({ headerName: 'cloudfront-forwarded-proto' })`, or supply
 * your own resolver that reads the request context the `hono/aws-lambda` adapter
 * exposes. Returns `undefined` when the header is absent (assertHttps then
 * rejects, failing closed).
 */
export function awsForwardedProto(
  opts: { headerName?: string; trustEdge?: boolean } = {},
): (c: Context) => string | undefined {
  const headerName = (opts.headerName ?? 'x-forwarded-proto').toLowerCase()
  const trustEdge = opts.trustEdge ?? true
  return (c: Context): string | undefined => {
    if (!trustEdge) {
      // No trusted edge: ignore the spoofable header. A Lambda Function URL only
      // ever serves HTTPS, so report `https` when we can confirm a real invoke
      // (request context present); otherwise fail closed.
      return requestContextSourceIp(c) !== undefined ? 'https' : undefined
    }
    const raw = c.req.header(headerName)
    if (raw === undefined) return undefined
    // A comma-joined chain can appear; the leftmost is the client-facing scheme.
    return raw.split(',')[0]!.trim().toLowerCase()
  }
}

// ---------------------------------------------------------------------------
// client IP (RATE-01)
// ---------------------------------------------------------------------------

/**
 * Resolve the client IP used as the per-IP rate-limit key.
 *
 * Reads the LEFTMOST entry of `X-Forwarded-For` — the original client IP as set
 * by ALB / API Gateway.
 *
 * TRUSTED-HOP ASSUMPTION (SECURITY-CRITICAL): `X-Forwarded-For` is client-
 * spoofable UNLESS every hop in front of this code is trusted and appends rather
 * than trusts. Behind ALB / API Gateway the leftmost value IS the real client IP
 * because AWS overwrites/normalizes the header at the edge. If you deploy WITHOUT
 * such an edge (e.g. a Lambda Function URL with no proxy), the leftmost value is
 * attacker-controlled — pass `{ trustEdge: false }` (the hardened default the
 * sample handler uses) to take the AWS-attested `requestContext.http.sourceIp`
 * instead of the header, or configure `{ trustedHopsFromRight }` to take the
 * Nth-from-right entry your trusted proxy appended. Falls back to `'unknown'`
 * when no source is present (so the limiter still buckets, rather than throwing).
 */
export function awsClientIp(
  opts: { trustedHopsFromRight?: number; trustEdge?: boolean } = {},
): (c: Context) => string {
  const fromRight = opts.trustedHopsFromRight
  const trustEdge = opts.trustEdge ?? true
  return (c: Context): string => {
    if (!trustEdge) {
      // No trusted edge: the only non-spoofable source is the AWS-attested
      // request-context IP. `X-Forwarded-For` is attacker-controlled here.
      return requestContextSourceIp(c) ?? 'unknown'
    }
    const xff = c.req.header('x-forwarded-for')
    if (!xff) return 'unknown'
    const parts = xff.split(',').map((p) => p.trim()).filter(Boolean)
    if (parts.length === 0) return 'unknown'
    if (fromRight !== undefined && fromRight > 0) {
      const idx = parts.length - fromRight
      // Underflow (fromRight exceeds the chain length) must NOT fall back to the
      // leftmost, client-controlled entry — that is a spoofable rate-limit key.
      // Fail closed to the AWS-attested source IP, else the 'unknown' bucket.
      return idx >= 0 ? parts[idx]! : (requestContextSourceIp(c) ?? 'unknown')
    }
    return parts[0]! // leftmost = original client (AWS-edge-normalized).
  }
}

// ---------------------------------------------------------------------------
// logger (LOG-01/04 → CloudWatch)
// ---------------------------------------------------------------------------

/**
 * A structured {@link Logger} that emits one JSON line per record via `console.*`.
 * On Lambda, `console` output lands in CloudWatch Logs; emitting JSON makes the
 * records queryable with CloudWatch Logs Insights. Core only ever passes
 * sanitized, PII-free records (LOG-11), so we serialize verbatim plus a `level`.
 */
export function createConsoleLogger(
  sink: Pick<typeof console, 'info' | 'warn' | 'error'> = console,
): Logger {
  const line = (level: 'info' | 'warn' | 'error', record: Record<string, unknown>): string =>
    JSON.stringify({ level, ...record })
  return {
    info: (record) => sink.info(line('info', record)),
    warn: (record) => sink.warn(line('warn', record)),
    error: (record) => sink.error(line('error', record)),
  }
}
