/**
 * Session lifecycle helpers (Phase S5, AUTH-04/05/06, CSRF-03).
 *
 * The server is the session authority (ARCH-03): the browser only ever holds an
 * opaque session id in a `__Host-` cookie (AUTH-03/06); everything else — the
 * principal, the CSRF synchronizer token, the absolute-expiry ceiling — lives in
 * the {@link SessionStore}. These helpers mint, rotate, and derive those records.
 *
 * All crypto is Web-standard (`crypto.getRandomValues`, `crypto.subtle`) — no
 * `node:*`, so the same code runs on Workers / Lambda / Node (ARCH-01, AUTH-13).
 */

import type { Principal, SessionRecord, SessionStore } from '../storage/index.js'
// TYPE-ONLY import (RT-03): the branded verified-claims type erases at compile
// time, so this does NOT pull `jose` into `session.ts`'s runtime graph — only
// `auth/oidc.ts` ever imports jose. Keeps non-OIDC consumers jose-free.
import type { VerifiedClaims } from './oidc.js'

// ---------------------------------------------------------------------------
// AuthConfig — fields Phase S5 needs that are NOT (yet) on SecurityConfig.
//
// `idleTtlSeconds` already lives on SecurityConfig and is reused by the
// authenticate phase; the fields below are session-cookie / lifecycle knobs the
// integrator should fold into SecurityConfig (see the integration note). They are
// declared here so this module is self-contained and testable in isolation.
// ---------------------------------------------------------------------------

/** `SameSite` policy for the session cookie (AUTH-03). `Lax` is the default. */
export type SameSite = 'Lax' | 'Strict'

/**
 * Session-lifecycle configuration consumed by {@link issueSession} et al.
 *
 * INTEGRATION: these are the exact fields to add to `SecurityConfig` (or a
 * `SecurityConfig.session` sub-object) so the OIDC-callback helper and the
 * authenticate phase can read them from the one injected config (ARCH-05):
 *   - cookieName       (default `__Host-session`)
 *   - absoluteTtlSeconds (AUTH-05 hard cap)
 *   - sameSite         (default `Lax`)
 *   - idleTtlSeconds   — ALREADY on SecurityConfig; reused, not duplicated.
 */
export interface AuthConfig {
  /** Cookie name — MUST keep the `__Host-` prefix to inherit its guarantees (AUTH-06). */
  cookieName?: string
  /** Absolute session lifetime in seconds — the hard cap TTL can't lift (AUTH-05). */
  absoluteTtlSeconds: number
  /** Initial idle TTL in seconds (AUTH-05). Slid on each request by `touch`. */
  idleTtlSeconds: number
  /** Cookie `SameSite` attribute (AUTH-03). Defaults to `Lax`. */
  sameSite?: SameSite
}

/**
 * Derive an {@link AuthConfig} from the unified {@link SecurityConfig} (OPS-06):
 * `idleTtlSeconds` from the top level, the rest from `config.session`. Lets a
 * service pass ONE config object to the pipeline and the session/route helpers.
 */
export function toAuthConfig(config: {
  idleTtlSeconds: number
  session?: { absoluteTtlSeconds: number; cookieName?: string; sameSite?: SameSite }
}): AuthConfig {
  if (!config.session) {
    throw new Error('toAuthConfig: config.session is required to issue cookie sessions (OPS-06)')
  }
  return {
    idleTtlSeconds: config.idleTtlSeconds,
    absoluteTtlSeconds: config.session.absoluteTtlSeconds,
    cookieName: config.session.cookieName,
    sameSite: config.session.sameSite,
  }
}

/** The canonical session cookie name — `__Host-` prefix implies Secure + Path=/ + no Domain (AUTH-06). */
export const DEFAULT_SESSION_COOKIE_NAME = '__Host-session'

// ---------------------------------------------------------------------------
// Absolute-expiry TTL clamp (AUTH-05, RT-10).
// ---------------------------------------------------------------------------

/**
 * Clamp a backend idle TTL so it can never outlive the absolute-expiry ceiling
 * (AUTH-05, RT-10). The backend store TTL is the *idle* timeout; on its own a
 * misconfiguration (`idleTtlSeconds > remaining absolute lifetime`) would let
 * the stored record survive past `absoluteExpiry`, so any code path that reads
 * the store WITHOUT going through `authenticate` (e.g. a custom route) would see
 * a session the absolute cap should have killed. Returning
 * `min(idleTtlSeconds, secondsUntilAbsoluteExpiry)` makes the cap hold at the
 * storage layer too — defense-in-depth independent of the pipeline.
 *
 * Inputs are seconds; `absoluteExpiryMs`/`nowMs` are epoch millis (the
 * record/`Date.now()` convention this module uses). Never returns a negative
 * value — a record at/past its ceiling clamps to `0` (a non-positive TTL is
 * treated as immediately-expired by the store).
 */
export function clampIdleToAbsolute(
  idleTtlSeconds: number,
  absoluteExpiryMs: number,
  nowMs: number,
): number {
  const secondsUntilAbsoluteExpiry = Math.floor((absoluteExpiryMs - nowMs) / 1000)
  return Math.max(0, Math.min(idleTtlSeconds, secondsUntilAbsoluteExpiry))
}

/** Bits of entropy for the session id and CSRF token (AUTH-04 requires ≥128). */
const TOKEN_BITS = 256
const TOKEN_BYTES = TOKEN_BITS / 8

// ---------------------------------------------------------------------------
// Token generation (AUTH-04, CSRF-03).
// ---------------------------------------------------------------------------

/**
 * Generate a CSPRNG token with ≥128 bits of entropy (we use {@link TOKEN_BITS}),
 * base64url-encoded so it is cookie-/header-safe. Backs both the session id
 * (AUTH-04) and the CSRF synchronizer token (CSRF-03).
 */
export function generateToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

/** Base64url (RFC 4648 §5), unpadded — URL/cookie-safe and fixed-alphabet. */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ---------------------------------------------------------------------------
// Constant-time comparison (AUTH-09).
// ---------------------------------------------------------------------------

/**
 * Constant-time string comparison for secrets (AUTH-09). Compares the full
 * byte length with a XOR-accumulator so the running time does not depend on the
 * position of the first differing byte. Lengths are mixed into the result so a
 * length mismatch cannot early-return and leak via timing.
 *
 * Use this anywhere a secret (e.g. a CSRF token in S8) is compared in code; the
 * session-id lookup itself is a store key fetch, where the backend does the
 * compare.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  // Key the loop length on the SECOND operand only (the secret in our callers —
  // e.g. the fixed-length stored CSRF token), NOT on `Math.max(...)`, so the
  // iteration count — and thus timing — does not depend on the attacker-supplied
  // operand `a`. A length mismatch is folded into the accumulator (so differing
  // lengths still return `false`) instead of changing the iteration count. `a` is
  // indexed modulo its own length so the read cost stays uniform regardless of
  // whether `a` is shorter or longer than `b`.
  let diff = ab.length ^ bb.length
  const len = bb.length
  // `aLen || 1` avoids a modulo-by-zero when `a` is empty; the length mismatch
  // already in `diff` guarantees the result is `false` in that case.
  const aLen = ab.length || 1
  for (let i = 0; i < len; i++) {
    diff |= (ab[i % aLen] ?? 0) ^ (bb[i] as number)
  }
  return diff === 0
}

// ---------------------------------------------------------------------------
// Cookie attribute serialization (AUTH-03/06).
// ---------------------------------------------------------------------------

/**
 * Build the `Set-Cookie` value for a session cookie (AUTH-03/06):
 * `HttpOnly; Secure; SameSite=...; Path=/` and NO `Domain` (the `__Host-`
 * prefix mandates exactly this — Secure, Path=/, host-only). The caller sets it
 * via `c.header('Set-Cookie', cookie)` (or Hono's `setCookie`).
 */
export function buildSessionCookie(
  name: string,
  value: string,
  sameSite: SameSite,
): string {
  // Order: name=value, then attributes. No Domain (host-only, AUTH-06).
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=${sameSite}`
}

// ---------------------------------------------------------------------------
// issueSession (AUTH-04/05/06, CSRF-03).
// ---------------------------------------------------------------------------

/** What {@link issueSession} returns to the caller (the app's OIDC-callback route). */
export interface IssuedSession {
  /** The opaque session id — store key and cookie value. Never logged. */
  sessionId: string
  /** The CSRF synchronizer token to hand to the browser (e.g. a readable cookie/body). */
  csrfToken: string
  /** The full `Set-Cookie` value for `__Host-session` (AUTH-03/06). */
  cookie: string
  /** The persisted record (handy for tests / immediate context priming). */
  record: SessionRecord
}

/**
 * Mint a brand-new session for `principal` and persist it (AUTH-04/05/06):
 *  - session id   ≥128-bit CSPRNG (AUTH-04), revocable via `store.delete`
 *  - csrfToken    ≥128-bit CSPRNG synchronizer token (CSRF-03)
 *  - createdAt    now; absoluteExpiry now + `absoluteTtlSeconds` (AUTH-05 hard cap)
 *  - store.set    with the initial idle TTL, clamped so it never exceeds the
 *                 remaining absolute lifetime (`idleTtlSeconds`, AUTH-05 idle
 *                 slide; RT-10 absolute-cap clamp)
 *
 * Returns the id, the CSRF token, and the `__Host-session` `Set-Cookie` value.
 */
export async function issueSession(
  store: SessionStore,
  principal: Principal,
  opts: AuthConfig,
): Promise<IssuedSession> {
  const sessionId = generateToken()
  const csrfToken = generateToken()
  const now = Date.now()
  const cookieName = opts.cookieName ?? DEFAULT_SESSION_COOKIE_NAME
  const sameSite = opts.sameSite ?? 'Lax'

  const record: SessionRecord = {
    principal,
    createdAt: now,
    absoluteExpiry: now + opts.absoluteTtlSeconds * 1000,
    csrfToken,
    claims: principal.claims,
  }

  // RT-10: never let the backend idle TTL outlive the absolute ceiling, so the
  // cap holds even for store reads that bypass `authenticate` (defense-in-depth).
  const ttlSeconds = clampIdleToAbsolute(opts.idleTtlSeconds, record.absoluteExpiry, now)
  await store.set(sessionId, record, ttlSeconds)

  return {
    sessionId,
    csrfToken,
    cookie: buildSessionCookie(cookieName, sessionId, sameSite),
    record,
  }
}

// ---------------------------------------------------------------------------
// rotateSession (AUTH-05 — rotate on privilege change).
// ---------------------------------------------------------------------------

/**
 * Rotate the session id on a privilege change (login, elevation) (AUTH-05):
 * issue a fresh session for `principal`, then delete the old id so the previous
 * cookie is immediately useless (defends session fixation). Returns the new
 * {@link IssuedSession}; the caller re-sets the `__Host-session` cookie from it.
 */
export async function rotateSession(
  store: SessionStore,
  oldSessionId: string,
  principal: Principal,
  opts: AuthConfig,
): Promise<IssuedSession> {
  const issued = await issueSession(store, principal, opts)
  await store.delete(oldSessionId)
  return issued
}

// ---------------------------------------------------------------------------
// OIDC seam (AUTH-08) — sessionFromOidcClaims.
// ---------------------------------------------------------------------------

/**
 * Maps a principal's permission scopes from already-validated ID-token claims.
 * Injected by the app so core never bakes in an IdP's scope/claim conventions.
 */
export type PermissionMapper = (claims: Record<string, unknown>) => string[]

/** Options for {@link sessionFromOidcClaims} beyond the base {@link AuthConfig}. */
export interface OidcSessionOptions extends AuthConfig {
  /**
   * Claim name to read the tenant/org id from (AUTHZ-07), if multi-tenant.
   * When set and present on the claims, populates `Principal.tenantId`.
   */
  tenantClaim?: string
}

/**
 * Mint a session from a **verified** OIDC ID-token claims set (AUTH-08, RT-03).
 *
 * COMPILE-TIME GUARD: `claims` is the branded {@link VerifiedClaims} type, which
 * is produced ONLY by `auth/oidc.ts`'s `verifyIdToken` / `OidcVerifier.verify`
 * (signature via the IdP JWKS, plus `iss` / `aud` / `exp` / `iat` / `nonce`).
 * A raw `Record<string, unknown>` is NOT assignable to `VerifiedClaims` (the
 * brand symbol is module-private), so an integrator can no longer mint a
 * fully-privileged session from an unverified claims bag — the verify half is
 * now mandatory and enforced by the type system (closes the RT-03 auth-bypass
 * seam). `auth/routes.ts`'s callback helper wires the two together.
 *
 * Maps claims → {@link Principal}: `id` from `sub`, `permissions` via the
 * injected {@link PermissionMapper}, optional `tenantId` from `opts.tenantClaim`,
 * `kind: 'user'`. Then delegates to {@link issueSession}.
 */
export async function sessionFromOidcClaims(
  store: SessionStore,
  claims: VerifiedClaims,
  mapPermissions: PermissionMapper,
  opts: OidcSessionOptions,
): Promise<IssuedSession> {
  const principal = principalFromOidcClaims(claims, mapPermissions, opts)
  return issueSession(store, principal, opts)
}

/**
 * Map a **verified** OIDC claims set → {@link Principal} (AUTHZ-07). The SINGLE
 * source of truth for the claim→principal mapping so the fresh-issue path
 * ({@link sessionFromOidcClaims}) and the rotate path (`auth/routes.ts`'s
 * `rotateOidcSession`) cannot drift: `id` from `sub`, `permissions` via the
 * injected mapper, `kind: 'user'`, and `tenantId` set ONLY when the tenant claim
 * is a NON-EMPTY string (an empty-string tenant claim must yield `undefined`, not
 * `''`, on both paths — the divergence this helper closes).
 */
export function principalFromOidcClaims(
  claims: VerifiedClaims,
  mapPermissions: PermissionMapper,
  opts: OidcSessionOptions,
): Principal {
  // `sub` is guaranteed non-empty by the verifier; re-checked as defense in depth.
  const sub = claims['sub']
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new Error('principalFromOidcClaims: claims.sub (subject) is required')
  }

  const principal: Principal = {
    id: sub,
    permissions: mapPermissions(claims),
    claims,
    kind: 'user',
  }

  if (opts.tenantClaim) {
    const tenant = claims[opts.tenantClaim]
    if (typeof tenant === 'string' && tenant.length > 0) {
      principal.tenantId = tenant
    }
  }

  return principal
}
