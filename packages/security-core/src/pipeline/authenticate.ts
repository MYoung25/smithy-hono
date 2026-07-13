/**
 * Pipeline phase 8 — `authenticate` (Phase S5, AUTH-01/05/10..12).
 *
 * Resolves a typed {@link Principal} from a `__Host-` cookie session (browser,
 * OIDC-backed) or defers to S6 for S2S signature verification. Runs BEFORE body
 * parsing (AUTH-11) so an unauthenticated request is rejected before any
 * expensive deserialization — shrinking the DoS surface.
 *
 * Branches (in order):
 *  - no op matched, or a SOLE `anonymous` posture          → `next()` (AUTH-01)
 *  - op is S2S (`sigv4Hmac`)                               → `next()` (S6 establishes it)
 *  - otherwise: cookie-session resolution; any failure     → uniform 401 (AUTH-10)
 *
 * Mixed posture (`anonymous` alongside an authenticating scheme): `anonymous` is
 * NOT a blanket opt-out. Cookie resolution is still attempted so a logged-in
 * caller is identified (principal set, `auth.success` audited, per-principal
 * rate-limited), but every resolution failure is DOWNGRADED to `next()` instead
 * of a 401 — because the op also permits anonymous. `authorize` then decides
 * based on the (possibly absent) principal vs `requiredPermissions`.
 *
 * On success it slides the idle TTL (AUTH-05) and sets BOTH `principal` and
 * `session` on the context — the latter lets CSRF (S8) read `session.csrfToken`
 * off the already-loaded record with no extra store round-trip.
 *
 * All session state goes through {@link SessionStore} (AUTH-12) — no in-memory
 * sessions here.
 */

import type { Context, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import type { SecurityConfig } from '../config.js'
import {
  DEFAULT_SESSION_COOKIE_NAME,
  buildSessionCookie,
  clampIdleToAbsolute,
} from '../auth/session.js'
import { buildAuditEvent, emitAudit, principalRef } from '../audit/audit.js'

// ---------------------------------------------------------------------------
// Local types — declared here so core never imports generated code, and so this
// phase does not couple to the placeholder in `./index.js`.
// ---------------------------------------------------------------------------

/** The subset of an auth scheme this phase branches on. */
interface AuthScheme {
  type: 'oidc' | 'sigv4Hmac' | 'anonymous' | string
}

/** The slice of `OperationMeta` (registry.gen.ts) this phase reads. */
interface AuthenticatableOperation {
  authSchemes: AuthScheme[]
  /** Operation name — used only for audit context (LOG-10); optional structurally. */
  name?: string
}

/** Resolve a live request (method + concrete path) → operation metadata. */
type OpResolver = (
  method: string,
  path: string,
) => AuthenticatableOperation | undefined

// ---------------------------------------------------------------------------
// Uniform 401 (AUTH-10) — one code path, one body, for every failure mode.
// ---------------------------------------------------------------------------

/**
 * The single 401 used for missing/expired/invalid sessions (AUTH-10): identical
 * status and body in every case so a probe can't tell "no session" from
 * "expired session" from "valid session, wrong user". Centralized so the shape
 * cannot drift between branches.
 */
function uniform401(c: Parameters<MiddlewareHandler>[0]): Response {
  return c.json({ code: 'Unauthorized' }, 401)
}

// ---------------------------------------------------------------------------
// Logout cookie-clearing (AUTH-SESSION-04).
//
// `POST /auth/logout` is registered with the `oidc` scheme so CSRF can guard it,
// which means `authenticate` runs first and would normally 401 a missing/invalid/
// expired session — but `logoutHandler` is documented as idempotent (always clears
// the cookie + 204). To honor that contract, this phase special-cases the logout
// route: on no_cookie/invalid_session/expired it emits the SAME session-clearing
// `Set-Cookie` (Max-Age=0) the handler would and returns 204, so logging out a
// stale/expired session always clears the cookie. No other route is affected.
// ---------------------------------------------------------------------------

const LOGOUT_METHOD = 'POST'
const DEFAULT_LOGOUT_PATH = '/auth/logout'

function isLogout(c: Context, logoutPath: string): boolean {
  return c.req.method.toUpperCase() === LOGOUT_METHOD && c.req.path === logoutPath
}

/**
 * Emit the session-clearing `Set-Cookie` (same attributes as
 * `auth/routes.ts`'s `logoutHandler`: `buildSessionCookie(name, '', sameSite)` plus
 * `Max-Age=0`) and return 204. Used when an auth failure on `POST /auth/logout`
 * would otherwise 401 and leave a stale cookie in place.
 */
function clearSessionAnd204(c: Context, cookieName: string): Response {
  c.header('Set-Cookie', `${buildSessionCookie(cookieName, '', 'Lax')}; Max-Age=0`, {
    append: true,
  })
  return c.body(null, 204)
}

// ---------------------------------------------------------------------------
// At-source audit emission (LOG-10). Emitted the instant the auth decision is
// made — the failure reason / identity context cannot be reconstructed later.
// ---------------------------------------------------------------------------

/**
 * Emit an `auth.failure` audit event then return the uniform 401. `principalRef`
 * is null (no identity was established); the failure `reason` is captured for the
 * trail but the uniform 401 body never reveals it to the client (AUTH-10). Audit
 * is best-effort — `emitAudit` never throws into the request path.
 */
async function denyAuth(
  config: SecurityConfig,
  c: Context,
  op: AuthenticatableOperation | undefined,
  reason: string,
): Promise<Response> {
  await emitAudit(
    config.audit,
    buildAuditEvent({
      type: 'auth.failure',
      requestId: (c.get('requestId') as string | undefined) ?? '',
      principalRef: null,
      operation: op?.name,
      outcome: 'deny',
      detail: { reason },
    }),
    config.logger,
  )
  return uniform401(c)
}

/**
 * Emit a best-effort `auth.failure` audit for a MIXED-posture request that
 * presented a credential which failed to resolve, but is being DOWNGRADED to
 * anonymous rather than denied (LOG-10 at-source coverage for that route class).
 * Unlike {@link denyAuth} this does NOT 401 — the caller still `next()`s through as
 * anonymous; only the audit record is added. `outcome: 'allow'` (the request
 * proceeds) with `downgraded: true` distinguishes it from a hard deny. Best-effort:
 * `emitAudit` never throws into the request path.
 */
async function auditMixedDowngrade(
  config: SecurityConfig,
  c: Context,
  op: AuthenticatableOperation | undefined,
  reason: string,
): Promise<void> {
  await emitAudit(
    config.audit,
    buildAuditEvent({
      type: 'auth.failure',
      requestId: (c.get('requestId') as string | undefined) ?? '',
      principalRef: null,
      operation: op?.name,
      outcome: 'allow',
      detail: { reason, downgraded: true },
    }),
    config.logger,
  )
}

// ---------------------------------------------------------------------------
// Scheme predicates.
// ---------------------------------------------------------------------------

function hasScheme(op: AuthenticatableOperation, type: string): boolean {
  return op.authSchemes.some((s) => s.type === type)
}

/**
 * True when the op declares any authenticating scheme alongside `anonymous`
 * (e.g. `['anonymous','oidc']`). In that mixed posture `anonymous` is NOT a
 * blanket opt-out: a request that DOES present a valid cookie session must be
 * identified (principal set, audited, per-principal rate-limited), while a
 * request without one still passes as anonymous. Only a SOLE `anonymous` posture
 * is a true opt-out.
 */
function hasAuthenticatingScheme(op: AuthenticatableOperation): boolean {
  return op.authSchemes.some((s) => s.type !== 'anonymous')
}

// ---------------------------------------------------------------------------
// authenticate — the phase factory.
// ---------------------------------------------------------------------------

/**
 * Build the cookie-session authentication middleware (pipeline phase 8).
 *
 * @param config   the injected {@link SecurityConfig} — uses `stores.session`
 *                 and `idleTtlSeconds`.
 * @param resolve  `(method, path) → OperationMeta | undefined` from the registry.
 */
export function authenticate(
  config: SecurityConfig,
  resolve: OpResolver,
): MiddlewareHandler {
  const cookieName = DEFAULT_SESSION_COOKIE_NAME
  const logoutPath = config.logoutPath ?? DEFAULT_LOGOUT_PATH
  const handler: MiddlewareHandler = async (c, next) => {
    const op = resolve(c.req.method, c.req.path)

    // AUTH-01: no matched op → no auth required.
    if (!op) {
      return next()
    }

    // AUTH-01: `anonymous` opt-out. A SOLE anonymous posture skips auth entirely.
    // A MIXED posture (`anonymous` + an authenticating scheme) still attempts
    // cookie resolution so a logged-in caller is identified, but DOWNGRADES every
    // failure to `next()` (the op also permits anonymous) — see `anonymousOk`.
    const anonymousOk = hasScheme(op, 'anonymous')
    if (anonymousOk && !hasAuthenticatingScheme(op)) {
      return next()
    }

    // S2S: signature verification (pipeline phase 9, S6) establishes the
    // principal for HMAC-signed requests — not this phase's job.
    if (hasScheme(op, 'sigv4Hmac')) {
      return next()
    }

    // Cookie-session (browser / OIDC) path. In a mixed anonymous posture a
    // failure is not a denial: fall through to `next()` so the request proceeds
    // as anonymous (`authorize` then decides based on the absent principal).
    const sessionStore = config.stores.session
    if (!sessionStore) {
      // Cookie auth required but no session backend wired — fail closed (AUTH-10).
      if (anonymousOk) return next()
      return denyAuth(config, c, op, 'no_session_backend')
    }

    const sid = getCookie(c, cookieName)
    if (!sid) {
      if (anonymousOk) return next()
      // AUTH-SESSION-04: logout is idempotent — clear the cookie + 204 instead of 401.
      if (isLogout(c, logoutPath)) return clearSessionAnd204(c, cookieName)
      return denyAuth(config, c, op, 'no_cookie')
    }

    // The store performs the key compare and applies idle-TTL / absolute-expiry
    // eviction; a missing or lapsed session comes back as null (AUTH-05/10).
    const rec = await sessionStore.get(sid)
    if (!rec) {
      if (anonymousOk) {
        // A cookie WAS presented but did not resolve — audit the downgrade (LOG-10)
        // before proceeding as anonymous. (Contrast the no_cookie branch above,
        // which is an ordinary anonymous request with no credential to trail.)
        await auditMixedDowngrade(config, c, op, 'invalid_session')
        return next()
      }
      // AUTH-SESSION-04: clear the stale cookie a logout names even when its
      // session is already gone server-side.
      if (isLogout(c, logoutPath)) return clearSessionAnd204(c, cookieName)
      return denyAuth(config, c, op, 'invalid_session')
    }

    // Defense in depth: enforce the absolute ceiling in-code too, in case a
    // backend only honors the idle TTL (AUTH-05 hard cap).
    if (rec.absoluteExpiry <= Date.now()) {
      if (anonymousOk) {
        // A valid-but-expired session was presented — audit the downgrade (LOG-10)
        // before proceeding as anonymous.
        await auditMixedDowngrade(config, c, op, 'expired')
        return next()
      }
      // AUTH-SESSION-04: an expired session still clears its cookie on logout.
      if (isLogout(c, logoutPath)) return clearSessionAnd204(c, cookieName)
      return denyAuth(config, c, op, 'expired')
    }

    // Slide the idle timeout on a successful access (AUTH-05), clamped so the
    // refreshed backend TTL never outlives the absolute ceiling (RT-10).
    await sessionStore.touch(
      sid,
      clampIdleToAbsolute(config.idleTtlSeconds, rec.absoluteExpiry, Date.now()),
    )

    c.set('principal', rec.principal)
    c.set('session', rec) // CSRF (S8) reads `session.csrfToken` for free.

    // LOG-10 at-source: the session resolved to an identity — emit `auth.success`
    // keyed to the pseudonymized principal (LOG-11, never the raw id).
    await emitAudit(
      config.audit,
      buildAuditEvent({
        type: 'auth.success',
        requestId: (c.get('requestId') as string | undefined) ?? '',
        principalRef: await principalRef(rec.principal.id, config.auditSalt),
        operation: op.name,
        outcome: 'allow',
      }),
      config.logger,
    )

    await next()
    return
  }
  Object.defineProperty(handler, 'name', { value: 'authenticate' })
  return handler
}
