/**
 * Pipeline phase 11 — `csrf` (S8, CSRF-*).
 *
 * Server-authoritative synchronizer-token CSRF check for **cookie-authenticated**
 * state-changing requests. Hono's built-in `csrf` is an Origin-check only, which
 * fails CSRF-02 (a same-origin XSS or a permissive Origin can defeat it); this
 * verifies a per-session secret instead. Web-standard only (ARCH-01): driven off
 * the Hono `Context`, the injected {@link SecurityConfig}, and the per-request op
 * from the registry resolver — no `node:*`, no module-level env reads (ARCH-05).
 *
 * Cookie-auth detection without the registry's auth scheme: the {@link
 * authenticate} phase (S5) sets `c.set('session', rec)` ONLY for a cookie/OIDC
 * session; S2S (HMAC) and bearer principals never get a `session`. So `!session`
 * is the exact, registry-free signal that this request is not cookie-authed and is
 * therefore immune to CSRF by construction — it `next()`s through.
 *
 * Free verification (CSRF-09): `authenticate` already loaded the {@link
 * SessionRecord} and stashed it in context, so this is a constant-time compare of
 * the request's `X-CSRF-Token` against `session.csrfToken` — NO extra store read.
 * The only write is at issuance/rotation (in `auth/session.ts`, already built).
 *
 * Dual-delivery model (the middleware only *verifies*; issuance lives in
 * `auth/session.ts`):
 *   - Default: the token is returned in the login / `GET /csrf-token` response
 *     body, held in SPA memory, and echoed back in the `X-CSRF-Token` request
 *     header. Topology-independent — works same- and cross-origin.
 *   - Optional convenience: a same-origin *readable* (`__Host-csrf`, non-HttpOnly)
 *     cookie the SPA copies into the header.
 *   - SameSite on the *session* cookie is defense-in-depth, not the primary
 *     control: `Lax` for same-site deploys, `None; Secure` for cross-site (where
 *     SameSite gives zero CSRF protection), so the synchronizer token carries the
 *     real guarantee.
 */

import type { MiddlewareHandler } from 'hono'
import type { SecurityConfig } from '../config.js'
// Reuse the audited constant-time compare (AUTH-09) — do NOT reimplement (CSRF-04).
import { timingSafeEqual } from '../auth/session.js'
// Type-only: never imports generated code; the structural shape is enough.
import type { PipelineOperationMeta } from './index.js'
// Type-only: gives `c.get('session')` its real type instead of `unknown`.
import type { SecurityEnv } from './context.js'

/** Local mirror of the pipeline's `OpResolver` (kept local per parallel-safety). */
type OpResolver = (
  method: string,
  path: string,
) => PipelineOperationMeta | undefined

// ---------------------------------------------------------------------------
// Config surface this module needs folded into the pipeline config (see report).
// ---------------------------------------------------------------------------

/**
 * Optional CSRF knobs. Defaults to the hardened baseline when omitted, so a
 * service need set nothing.
 */
export interface CsrfConfig {
  /** Request header carrying the synchronizer token. Default `X-CSRF-Token`. */
  csrfHeaderName?: string
}

/**
 * CSRF-06 secondary check (defense-in-depth, NOT the primary control).
 *
 * The synchronizer-token compare below is and stays the gate. This is an extra,
 * cheap reject for the case where a browser DOES advertise the request's
 * provenance: an `Origin` header or `Sec-Fetch-Site: cross-site` that proves the
 * request came from a different site is rejected before we even look at the
 * token. It only ever ADDS rejections — when neither signal is present (e.g. a
 * non-browser client, or a stripped header), behavior is unchanged and the token
 * remains the sole gate, so this can never weaken the existing guarantee.
 *
 * Returns `true` when the request is provably cross-site and must be rejected.
 * The allowed set is `config.allowedOrigins` (reused from the CORS/CSRF layer).
 */
function isCrossSiteRequest(
  origin: string | undefined,
  secFetchSite: string | undefined,
  allowedOrigins: readonly string[],
  selfOrigin: string | undefined,
): boolean {
  // `Sec-Fetch-Site` is the browser's own classification (most trustworthy when
  // present): `same-origin`/`same-site`/`none` are safe; `cross-site` is hostile.
  if (secFetchSite) {
    if (secFetchSite === 'cross-site') return true
    // `same-origin`/`same-site`/`none` → not cross-site; the token still gates.
    return false
  }
  // No Sec-Fetch-Site: fall back to an explicit Origin check. A same-ORIGIN request
  // is never cross-site even when the service's own origin isn't in the CORS
  // allowlist (a same-origin SPA+API deploy legitimately omits self from
  // allowedOrigins) — otherwise a browser that strips Sec-Fetch-Site (older Safari
  // / proxies) would get a false-positive 403 on a valid same-origin POST. So only
  // reject when the Origin is BOTH not our own AND not allowlisted. `Origin: null`
  // (opaque origin, e.g. a sandboxed iframe) matches neither and is cross-site.
  if (origin) {
    return origin !== selfOrigin && !allowedOrigins.includes(origin)
  }
  // Neither header present → we cannot classify; do NOT reject here (CSRF-06:
  // the synchronizer token remains the gate when provenance is unknown).
  return false
}

/** The config `csrf` reads — `SecurityConfig` plus this module's knobs. */
export type CsrfPipelineConfig = SecurityConfig & CsrfConfig

/** The default header the synchronizer token is echoed back in (CSRF-*). */
const DEFAULT_CSRF_HEADER = 'X-CSRF-Token'

// ---------------------------------------------------------------------------
// csrf — the phase factory (pipeline phase 11).
// ---------------------------------------------------------------------------

/**
 * Build the CSRF middleware (pipeline phase 11).
 *
 * Order of bypass checks (each `next()`s through):
 *   1. No session in context (`!c.get('session')`) → not cookie-authed; S2S/bearer
 *      are immune by construction (the registry's auth scheme need not be read).
 *   2. The resolved op is `@readonly` → a safe method, exempt (CSRF — only
 *      state-changing cookie-authed requests are enforced).
 *
 * Then a secondary reject (CSRF-06, defense-in-depth): a provably cross-site
 * `Origin`/`Sec-Fetch-Site` is rejected up-front. When those headers are absent,
 * behavior is unchanged and the synchronizer token remains the sole gate.
 *
 * Otherwise: constant-time compare the request's CSRF header against the
 * already-loaded `session.csrfToken` (CSRF-04). Mismatch → `403 CsrfFailed`.
 *
 * @param config  the injected {@link SecurityConfig} plus {@link CsrfConfig}.
 * @param resolve `(method, path) → OperationMeta | undefined` from the registry.
 */
export function csrf(config: CsrfPipelineConfig, resolve: OpResolver): MiddlewareHandler {
  const headerName = config.csrfHeaderName ?? DEFAULT_CSRF_HEADER

  const handler: MiddlewareHandler<SecurityEnv> = async (c, next) => {
    // 1 — Cookie-auth detection. No session loaded ⇒ S2S/bearer ⇒ immune (CSRF-*).
    const session = c.get('session')
    if (!session) return next()

    // 2 — Safe methods are exempt (CSRF — @readonly from the registry, not hand-wired).
    const op = resolve(c.req.method, c.req.path)
    if (op?.readonly) return next()

    // 3 — CSRF-06 secondary check (defense-in-depth, token stays PRIMARY): if the
    // browser advertised a provably cross-site provenance (`Sec-Fetch-Site:
    // cross-site`, or an `Origin` outside the allowlist), reject up-front. When
    // neither header is present, behavior is unchanged — the token still gates.
    // The service's own origin — used so a same-origin request whose Origin isn't
    // in the CORS allowlist is not falsely flagged cross-site when Sec-Fetch-Site
    // is absent. Parsing failures leave it undefined (falls back to allowlist-only).
    let selfOrigin: string | undefined
    try {
      selfOrigin = new URL(c.req.url).origin
    } catch {
      selfOrigin = undefined
    }
    if (
      isCrossSiteRequest(
        c.req.header('Origin'),
        c.req.header('Sec-Fetch-Site'),
        config.allowedOrigins,
        selfOrigin,
      )
    ) {
      return c.json({ code: 'CsrfFailed' }, 403)
    }

    // Synchronizer-token compare against the already-loaded session (no extra read).
    const expected = session.csrfToken
    const provided = c.req.header(headerName) ?? ''
    // Empty-token floor (RT-09): `timingSafeEqual('', '')` is `true` (the XOR
    // accumulator over zero-length inputs is 0), so an empty STORED token would
    // validate against an absent/empty header — a CSRF bypass on a malformed or
    // partial session record. Reject before the compare whenever either side is
    // empty: a CSRF secret can never legitimately be the empty string. The real
    // (non-empty) compare below stays constant-time (CSRF-04); this guard only
    // fires on a degenerate, never-legitimate input, so it leaks nothing about a
    // valid token.
    if (expected.length === 0 || provided.length === 0 || !timingSafeEqual(provided, expected)) {
      // Constant-time compare (CSRF-04); uniform 403 regardless of why it failed.
      return c.json({ code: 'CsrfFailed' }, 403)
    }
    await next()
    return
  }
  Object.defineProperty(handler, 'name', { value: 'csrf' })
  return handler as MiddlewareHandler
}
