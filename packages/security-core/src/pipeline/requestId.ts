/**
 * Pipeline phase 1 — `requestId` (S9, LOG-01).
 *
 * The outermost correlation layer. It MUST be first to see the request and last
 * to touch the response, so EVERY response — including ones an inner phase
 * rejects or that throw — carries an `X-Request-Id` that ties the client-visible
 * outcome to its log line and audit events (LOG-01/04, doc 10).
 *
 * Web-standard only (ARCH-01): the id is minted with `crypto.getRandomValues`,
 * base64url-encoded (cookie-/header-safe) — no `node:*`, no `Buffer`, no
 * module-level env reads (ARCH-05).
 *
 * An incoming `X-Request-Id` is honored for distributed tracing, but only after
 * sanitization: a client-supplied value flows straight into log records and the
 * response header, so an unbounded / control-character value is a log-forging /
 * header-injection vector. We therefore accept an incoming id only when it is
 * short and drawn from a conservative token charset; anything else is silently
 * replaced with a freshly minted id (fail safe — we never reflect attacker bytes,
 * and the request still gets a usable correlation id).
 */

import type { MiddlewareHandler } from 'hono'
import type { SecurityEnv } from './context.js'

/** Bytes of entropy for a minted id (128 bits — ample for collision-free correlation). */
const ID_BYTES = 16

/**
 * Max accepted length of an incoming `X-Request-Id`. Generous enough for common
 * trace formats (UUID, W3C trace-id, our base64url ids) yet bounded so a hostile
 * value can't bloat every log line it appears in.
 */
const MAX_INCOMING_ID_LEN = 128

/**
 * Allowed charset for an incoming id: base64url, plus the hyphen/dot/colon common
 * in trace identifiers. Deliberately excludes whitespace, newlines, and control
 * characters so a reflected id can't forge a log line or inject a response header.
 */
const INCOMING_ID_PATTERN = /^[A-Za-z0-9._:-]+$/

/** Base64url (RFC 4648 §5), unpadded — URL/header-safe and fixed-alphabet. */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Mint a fresh CSPRNG correlation id (128-bit, base64url). */
function randomId(): string {
  const bytes = new Uint8Array(ID_BYTES)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

/**
 * Return the incoming id when it is safe to reflect, else `undefined` so the
 * caller mints a fresh one. "Safe" = non-empty, within {@link MAX_INCOMING_ID_LEN},
 * and matching the conservative {@link INCOMING_ID_PATTERN}.
 */
function sanitizeIncomingId(incoming: string | undefined): string | undefined {
  if (incoming === undefined) return undefined
  if (incoming.length === 0 || incoming.length > MAX_INCOMING_ID_LEN) return undefined
  if (!INCOMING_ID_PATTERN.test(incoming)) return undefined
  return incoming
}

/**
 * Phase 1 — attach a correlation id to the request and EVERY response.
 *
 * Honors a sanitized incoming `X-Request-Id` (distributed tracing) or mints a
 * fresh one. Sets `c.set('requestId', id)` for downstream phases (logger, audit,
 * error sanitizer) and writes the header *after* `next()` so the id rides out on
 * every response — successes, inner rejections, and 404s alike.
 *
 * Takes no config: correlation is unconditional (every request needs an id even
 * when structured logging is off).
 */
export function requestId(): MiddlewareHandler<SecurityEnv> {
  const handler: MiddlewareHandler<SecurityEnv> = async (c, next) => {
    const incoming = c.req.header('X-Request-Id')
    const id = sanitizeIncomingId(incoming) ?? randomId()
    c.set('requestId', id)
    await next()
    // Set on the way out so the id is present on every response, including the
    // ones produced by an inner phase rejecting or throwing.
    c.header('X-Request-Id', id)
  }
  Object.defineProperty(handler, 'name', { value: 'requestId' })
  return handler
}
