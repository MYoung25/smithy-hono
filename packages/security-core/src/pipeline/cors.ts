/**
 * Pipeline phase 6 — `cors` (S8, CORS-*).
 *
 * Cross-origin gate + CORS-preflight short-circuit. It runs **early** in the
 * pipeline — before `authenticate` and the body guards (ARCH-07) — so an
 * `OPTIONS` preflight is answered here and the chain is cut: a preflight carries
 * no credentials and MUST NEVER reach auth or trigger body parsing. Web-standard
 * only (ARCH-01): everything is driven off the Hono `Context` and the injected
 * {@link SecurityConfig} — no `node:*`, no module-level env reads (ARCH-05).
 *
 * Allowed origins come from `config.allowedOrigins` (ARCH-05) — never module
 * constants, so a deployment re-policies without forking core. This is
 * implemented directly rather than wrapping Hono's `cors` middleware precisely so
 * the origin allow-list is config-injected.
 *
 * Credentialed-CORS discipline (CORS-*):
 *   - `Access-Control-Allow-Origin` echoes the *specific* request origin, NEVER
 *     `*` — a wildcard with `Access-Control-Allow-Credentials: true` is illegal
 *     per the Fetch spec and would be a credential-leak hole anyway.
 *   - `Access-Control-Allow-Credentials: true` so the browser sends/receives the
 *     `__Host-session` cookie cross-origin where the origin is allow-listed.
 *   - `Vary: Origin` so a shared cache never serves one origin's CORS response to
 *     another (correctness + security; without it a CDN can poison the ACAO).
 *
 * Coordinate with VAL-06 (bodyGuards content-type): strict content-type
 * enforcement closes the "lazy-CORS bypass" — a simple-request form/text POST
 * that skips preflight is still rejected at the body guard because it doesn't
 * carry the modeled `application/json` content-type. CORS here is the browser
 * gate; VAL-06 is the belt-and-braces server gate.
 */

import type { MiddlewareHandler } from 'hono'
import type { SecurityConfig } from '../config.js'

// ---------------------------------------------------------------------------
// Config surface this module needs folded into the pipeline config (see report).
// ---------------------------------------------------------------------------

/**
 * Optional CORS policy overrides. Origins are NOT here — they live on
 * {@link SecurityConfig.allowedOrigins} (ARCH-05). Everything below defaults to
 * the hardened API-JSON baseline when omitted, so a service need set nothing.
 */
export interface CorsConfig {
  cors?: {
    /**
     * Methods advertised in the preflight `Access-Control-Allow-Methods`
     * response. Default {@link DEFAULT_ALLOWED_METHODS}.
     */
    allowedMethods?: string[]
    /**
     * Request headers advertised in `Access-Control-Allow-Headers`. Default
     * {@link DEFAULT_ALLOWED_HEADERS} (includes `X-CSRF-Token` so the synchronizer
     * token can be echoed cross-origin, S8).
     */
    allowedHeaders?: string[]
    /**
     * Response headers exposed to JS via `Access-Control-Expose-Headers` on
     * actual (non-preflight) responses. Default: none (omitted when empty).
     */
    exposeHeaders?: string[]
    /**
     * Preflight cache lifetime in seconds (`Access-Control-Max-Age`). Default
     * {@link DEFAULT_MAX_AGE_SECONDS}.
     */
    maxAgeSeconds?: number
  }
}

/** The config `cors` reads — `SecurityConfig` (for `allowedOrigins`) plus knobs. */
export type CorsPipelineConfig = SecurityConfig & CorsConfig

// ---------------------------------------------------------------------------
// Defaults (the hardened API-JSON baseline; overridable via CorsConfig).
// ---------------------------------------------------------------------------

const DEFAULT_ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
const DEFAULT_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-CSRF-Token',
  'X-Request-Id',
]
const DEFAULT_MAX_AGE_SECONDS = 600

// ---------------------------------------------------------------------------
// cors — the phase factory (pipeline phase 6).
// ---------------------------------------------------------------------------

/**
 * Build the CORS middleware (pipeline phase 6).
 *
 * Behavior:
 *   - Reads the `Origin` request header. `allowed` ⇔ a non-empty origin that is
 *     present in `config.allowedOrigins`.
 *   - `OPTIONS` (preflight): if allowed, set the full preflight CORS header set;
 *     return `204` and SHORT-CIRCUIT — the preflight never reaches auth/body
 *     guards. If NOT allowed, still return `204` but with no CORS headers, so the
 *     browser blocks the subsequent actual request.
 *   - Non-`OPTIONS`: if allowed, set the actual-response CORS headers, then
 *     `await next()`; if not allowed, just `await next()` with no CORS headers —
 *     same-origin and non-browser clients still work, a cross-origin browser
 *     request is blocked at the JS boundary.
 *
 * @param config the injected {@link SecurityConfig} (origins) plus {@link CorsConfig}.
 */
export function cors(config: CorsPipelineConfig): MiddlewareHandler {
  // Precompute the static, config-derived preflight values (request-independent).
  const allowMethods = (config.cors?.allowedMethods ?? DEFAULT_ALLOWED_METHODS).join(', ')
  const allowHeaders = (config.cors?.allowedHeaders ?? DEFAULT_ALLOWED_HEADERS).join(', ')
  const maxAge = String(config.cors?.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS)
  const exposeHeaders = (config.cors?.exposeHeaders ?? []).join(', ')

  const handler: MiddlewareHandler = async (c, next) => {
    const origin = c.req.header('Origin')
    const allowed = !!origin && config.allowedOrigins.includes(origin)

    if (c.req.method === 'OPTIONS') {
      // Preflight short-circuit: answer here, never fall through to auth/body.
      if (allowed) {
        // origin is a string when allowed is true.
        setSharedCorsHeaders(c, origin as string)
        c.header('Access-Control-Allow-Methods', allowMethods)
        c.header('Access-Control-Allow-Headers', allowHeaders)
        c.header('Access-Control-Max-Age', maxAge)
      }
      // `Vary: Origin` on EVERY preflight — allowed or not — so a shared cache
      // keys on the origin (CORS-*). No downstream runs on this short-circuit, so
      // the write is final. Disallowed origin → 204 with no other CORS headers
      // (browser will block the subsequent actual request).
      addVary(c, 'Origin')
      return c.body(null, 204)
    }

    if (allowed) {
      setSharedCorsHeaders(c, origin as string)
      if (exposeHeaders.length > 0) {
        c.header('Access-Control-Expose-Headers', exposeHeaders)
      }
    }
    await next()
    // `Vary: Origin` on EVERY actual response — allowed or not — so a shared
    // cache never serves one origin's response to another (CORS-*). Emitted AFTER
    // `next()` and MERGED (not overwritten) so a `Vary` a downstream contributor
    // set (e.g. content negotiation / compression) survives alongside `Origin`.
    addVary(c, 'Origin')
  }
  Object.defineProperty(handler, 'name', { value: 'cors' })
  return handler
}

/**
 * Set the CORS headers common to both preflight and actual responses: echo the
 * specific origin (NEVER `*` — credentialed) and allow credentials. `Vary:
 * Origin` is set once, unconditionally, by the handler itself (see {@link
 * addVary}) so it rides every response regardless of the allow decision.
 */
function setSharedCorsHeaders(
  c: Parameters<MiddlewareHandler>[0],
  origin: string,
): void {
  c.header('Access-Control-Allow-Origin', origin) // specific origin, never '*'
  c.header('Access-Control-Allow-Credentials', 'true')
}

/**
 * Add a token to the response `Vary` header without clobbering any value already
 * present. Hono's `c.header(name, value)` is a `set` (overwrite), so a plain
 * write would drop a downstream `Vary: Accept-Encoding` and collapse the
 * cache-key dimensions to one. We read the current value, token-split it, and
 * write the deduped union back — so `Origin` is added exactly once and any
 * pre-existing vary-dimension survives (cache-correctness, CORS-*).
 */
function addVary(c: Parameters<MiddlewareHandler>[0], token: string): void {
  const existing = c.res?.headers.get('Vary') ?? ''
  const tokens = existing
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  if (tokens.some((t) => t.toLowerCase() === token.toLowerCase())) return
  tokens.push(token)
  c.header('Vary', tokens.join(', '))
}
