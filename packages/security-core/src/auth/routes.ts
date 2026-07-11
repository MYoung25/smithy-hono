/**
 * OIDC auth route helpers (Phase S5, RT-04 + RT-05).
 *
 * Ready-to-mount Hono handler factories for the cookie/OIDC browser flow,
 * composed from the existing primitives — `issueSession` / `rotateSession`
 * (`auth/session.ts`) and the `verifyIdToken` verifier (`auth/oidc.ts`):
 *
 *   - {@link loginHandler}     `GET`  — start: redirect to the IdP authorize
 *                              endpoint with `state` + `nonce` (+ PKCE), stored
 *                              in a short-lived signed transaction cookie.
 *   - {@link callbackHandler}  `GET`  — exchange the `code`, VERIFY the ID token
 *                              (RT-03), establish a session, ROTATE any pre-auth
 *                              session id (RT-05 anti-fixation), set `__Host-`
 *                              cookie, return the CSRF token in the body.
 *   - {@link logoutHandler}    `POST` — delete the session + clear the cookie.
 *   - {@link csrfTokenHandler} `GET`  — return the authenticated session's CSRF
 *                              token (SPA double-submit; closes RT-04 / the
 *                              `csrf.ts:24` `/csrf-token` reference).
 *
 * These are REFERENCE helpers: thin, composable, Web-standard only (ARCH-01 — no
 * `node:*`, no `Buffer`; PKCE/state crypto via `crypto.subtle` + `getRandomValues`).
 * The login↔callback transaction (`state` / `nonce` / PKCE `code_verifier`) is
 * carried in a single HMAC-SIGNED, HttpOnly, short-TTL cookie (`__Host-oidc-tx`)
 * keyed by an app-supplied secret — the simplest correct, store-free approach;
 * swap in an injected server-side store if you prefer not to round-trip it to the
 * browser. Only this module imports `auth/oidc.ts` (and therefore jose) — it is
 * tree-shakeable away from non-OIDC deploys.
 */

import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import type { SessionStore } from '../storage/index.js'
import {
  DEFAULT_SESSION_COOKIE_NAME,
  buildSessionCookie,
  issueSession,
  principalFromOidcClaims,
  rotateSession,
  sessionFromOidcClaims,
  type AuthConfig,
  type IssuedSession,
  type PermissionMapper,
  type OidcSessionOptions,
} from './session.js'
import {
  OidcVerificationError,
  createOidcVerifier,
  type OidcConfig,
  type OidcVerifier,
  type VerifiedClaims,
} from './oidc.js'

// ---------------------------------------------------------------------------
// Module-local config slice (the established pattern — see report for canonical
// SecurityConfig fields to add: issuer, clientId, audience, redirectUri,
// authorizationEndpoint, tokenEndpoint, oidcStateSecret).
// ---------------------------------------------------------------------------

/** The transaction cookie carrying `state` / `nonce` / PKCE between login and callback. */
const DEFAULT_TX_COOKIE_NAME = '__Host-oidc-tx'
/** Transaction cookie lifetime — the user must finish the IdP round-trip within this. */
const DEFAULT_TX_TTL_SECONDS = 600

/**
 * Everything the route helpers need. Module-local (not on `SecurityConfig`);
 * the integrator constructs it from canonical `SecurityConfig` fields (see report).
 */
export interface AuthRoutesConfig {
  /** The session store (`config.stores.session`) — session authority (ARCH-03). */
  store: SessionStore
  /** Session-cookie / lifecycle knobs reused by `issueSession`/`rotateSession`. */
  session: OidcSessionOptions
  /** ID-token verifier config (issuer, audience, jwks) — see {@link OidcConfig}. */
  oidc: OidcConfig
  /** OAuth/OIDC client id (the `aud` and the `client_id` authorize/token param). */
  clientId: string
  /** Client secret for the token exchange (confidential client). Optional for PKCE-public clients. */
  clientSecret?: string
  /** Redirect URI registered with the IdP — where the callback handler is mounted. */
  redirectUri: string
  /** The IdP authorize endpoint (from discovery / config). */
  authorizationEndpoint: string
  /** The IdP token endpoint (code → tokens exchange). */
  tokenEndpoint: string
  /** Requested scopes. Default `['openid']`; add `profile`/`email`/custom scopes. */
  scopes?: string[]
  /** Maps verified claims → permissions (injected; core bakes in no IdP conventions). */
  mapPermissions: PermissionMapper
  /**
   * HMAC secret for signing the transaction cookie (`__Host-oidc-tx`). MUST be a
   * high-entropy per-deployment value; a tampered/forged transaction cookie is
   * rejected, defeating state/nonce stripping. NOT the session secret.
   */
  stateSecret: string
  /** Override the transaction cookie name. Default `__Host-oidc-tx`. */
  txCookieName?: string
  /** Override the transaction TTL (seconds). Default `600`. */
  txTtlSeconds?: number
  /**
   * A pre-built verifier to reuse across requests (keeps the JWKS cache warm —
   * recommended). When omitted, each callback builds one from {@link oidc}.
   */
  verifier?: OidcVerifier
}

// ---------------------------------------------------------------------------
// PKCE + random helpers (Web-standard only — ARCH-01).
// ---------------------------------------------------------------------------

/** base64url (RFC 4648 §5), unpadded — URL-safe, fixed alphabet. */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A high-entropy URL-safe random string (used for `state` and the PKCE verifier). */
function randomUrlToken(bytes = 32): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return base64UrlEncode(buf)
}

/** PKCE S256 challenge: base64url(SHA-256(verifier)) (RFC 7636). */
async function pkceChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64UrlEncode(new Uint8Array(digest))
}

// ---------------------------------------------------------------------------
// Transaction state (state + nonce + PKCE verifier), carried in a signed cookie.
// ---------------------------------------------------------------------------

interface OidcTransaction {
  state: string
  nonce: string
  codeVerifier: string
  /** Optional post-login redirect target the SPA asked for. */
  returnTo?: string
}

/** Base name for the per-transaction cookie (a short `txid` is appended). */
function txCookieBaseName(config: AuthRoutesConfig): string {
  return config.txCookieName ?? DEFAULT_TX_COOKIE_NAME
}

/**
 * The per-transaction cookie name `<base>-<txid>` (AUTH-SESSION-05). Keying the
 * cookie on a fresh random `txid` per login means parallel/multi-tab logins write
 * DISTINCT cookies instead of clobbering one shared slot — each callback reads
 * back its OWN transaction. Still `__Host-`-eligible: the prefix constrains only
 * `Secure` / `Path=/` / no-`Domain`, not the name suffix.
 */
function txCookieName(config: AuthRoutesConfig, txid: string): string {
  return `${txCookieBaseName(config)}-${txid}`
}

/** Persist the transaction in a signed, HttpOnly, short-TTL `__Host-` cookie keyed by `txid`. */
async function setTransactionCookie(
  c: Context,
  config: AuthRoutesConfig,
  txid: string,
  tx: OidcTransaction,
): Promise<void> {
  await setSignedCookie(c, txCookieName(config, txid), JSON.stringify(tx), config.stateSecret, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: config.txTtlSeconds ?? DEFAULT_TX_TTL_SECONDS,
  })
}

/**
 * Read + validate the signed transaction cookie for `txid`; `null` if
 * absent/forged/malformed.
 */
async function readTransactionCookie(
  c: Context,
  config: AuthRoutesConfig,
  txid: string,
): Promise<OidcTransaction | null> {
  const raw = await getSignedCookie(c, config.stateSecret, txCookieName(config, txid))
  if (typeof raw !== 'string' || raw.length === 0) return null
  try {
    const parsed = JSON.parse(raw) as Partial<OidcTransaction>
    if (
      typeof parsed.state === 'string' &&
      typeof parsed.nonce === 'string' &&
      typeof parsed.codeVerifier === 'string'
    ) {
      return parsed as OidcTransaction
    }
  } catch {
    // fall through — malformed payload is treated as no transaction.
  }
  return null
}

/** Clear the `txid` transaction cookie once the round-trip completes (or fails). */
function clearTransactionCookie(c: Context, config: AuthRoutesConfig, txid: string): void {
  deleteCookie(c, txCookieName(config, txid), { path: '/', secure: true })
}

/**
 * Parse the `txid` out of a returned OAuth `state` value (`<txid>.<random>`).
 * Returns `null` for a malformed/empty state so the callback fails closed. The
 * `txid` is a base64url token (no `.`), so the first `.` is an unambiguous split.
 */
function txidFromState(state: string): string | null {
  const dot = state.indexOf('.')
  if (dot <= 0) return null
  const txid = state.slice(0, dot)
  return txid.length > 0 ? txid : null
}

// ---------------------------------------------------------------------------
// loginHandler — start the OIDC authorization-code + PKCE flow.
// ---------------------------------------------------------------------------

/**
 * `GET` login initiator. Generates `state` + `nonce` + a PKCE `code_verifier`,
 * stores them in the signed transaction cookie, and 302-redirects to the IdP
 * authorize endpoint with `response_type=code`, `code_challenge` (S256), the
 * `state`, and the `nonce`. A `?returnTo=` query (same-origin path) is preserved
 * through the round-trip.
 *
 * The matching {@link callbackHandler} consumes the transaction cookie to bind
 * `state`/`nonce` and complete PKCE — defeating CSRF on the callback and ID-token
 * replay.
 */
export function loginHandler(config: AuthRoutesConfig): MiddlewareHandler {
  const scopes = config.scopes ?? ['openid']
  const handler: MiddlewareHandler = async (c) => {
    // A fresh transaction id keys this login's cookie so concurrent/multi-tab
    // logins don't clobber each other (AUTH-SESSION-05). It is carried back to us
    // inside the OAuth `state` as `<txid>.<random>`; the random half keeps the
    // full state high-entropy and unguessable.
    const txid = randomUrlToken(8)
    const state = `${txid}.${randomUrlToken()}`
    const nonce = randomUrlToken()
    const codeVerifier = randomUrlToken(48)
    const codeChallenge = await pkceChallengeS256(codeVerifier)

    const returnToRaw = c.req.query('returnTo')
    // Only honor same-origin absolute PATHS as returnTo (open-redirect defense).
    // Resolution-based validation: parse against a placeholder origin and accept
    // ONLY when it stays same-origin. A prefix check (`/` && !`//`) is bypassable
    // via a backslash (`/\evil.com`), tab/newline, or other escapes that URL
    // normalizes to a foreign host; resolving uniformly rejects all of them while
    // still yielding a same-origin path+query+hash string (contract preserved).
    const returnTo = ((): string | undefined => {
      if (typeof returnToRaw !== 'string') return undefined
      let u: URL
      try {
        u = new URL(returnToRaw, 'https://placeholder.invalid')
      } catch {
        return undefined
      }
      if (u.origin !== 'https://placeholder.invalid') return undefined
      return u.pathname + u.search + u.hash
    })()

    await setTransactionCookie(c, config, txid, { state, nonce, codeVerifier, returnTo })

    const authorizeUrl = new URL(config.authorizationEndpoint)
    authorizeUrl.searchParams.set('response_type', 'code')
    authorizeUrl.searchParams.set('client_id', config.clientId)
    authorizeUrl.searchParams.set('redirect_uri', config.redirectUri)
    authorizeUrl.searchParams.set('scope', scopes.join(' '))
    authorizeUrl.searchParams.set('state', state)
    authorizeUrl.searchParams.set('nonce', nonce)
    authorizeUrl.searchParams.set('code_challenge', codeChallenge)
    authorizeUrl.searchParams.set('code_challenge_method', 'S256')

    return c.redirect(authorizeUrl.toString(), 302)
  }
  Object.defineProperty(handler, 'name', { value: 'oidcLogin' })
  return handler
}

// ---------------------------------------------------------------------------
// Token exchange (code → tokens) at the IdP token endpoint.
// ---------------------------------------------------------------------------

/** The slice of the token-endpoint response we consume. */
interface TokenResponse {
  id_token?: string
  access_token?: string
  token_type?: string
  expires_in?: number
}

/**
 * Exchange an authorization `code` for tokens at the token endpoint (PKCE).
 * Throws {@link OidcVerificationError} on any non-2xx / missing-id_token result
 * so the callback maps it to a uniform `401`.
 */
async function exchangeCode(
  config: AuthRoutesConfig,
  code: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: codeVerifier,
  })
  if (config.clientSecret) body.set('client_secret', config.clientSecret)

  let res: Response
  try {
    res = await fetch(config.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    })
  } catch (cause) {
    throw new OidcVerificationError('token exchange request failed', { cause })
  }
  if (!res.ok) {
    throw new OidcVerificationError(`token exchange failed: ${res.status}`)
  }
  const json = (await res.json()) as TokenResponse
  if (typeof json.id_token !== 'string' || json.id_token.length === 0) {
    throw new OidcVerificationError('token response missing id_token')
  }
  return json
}

// ---------------------------------------------------------------------------
// callbackHandler — verify ID token, establish + ROTATE session (RT-03 + RT-05).
// ---------------------------------------------------------------------------

/** Shape of the successful callback JSON body. */
export interface CallbackResult {
  ok: true
  /** The CSRF synchronizer token for the SPA to echo in `X-CSRF-Token` (CSRF-03). */
  csrfToken: string
  /** The same-origin path the login initiator asked to return to, if any. */
  returnTo?: string
}

/**
 * `GET` OIDC callback. Completes the flow (RT-03 verify + RT-05 rotation):
 *  1. Read + clear the signed transaction cookie; bind `state` (CSRF on callback).
 *  2. Exchange `code` (+ PKCE `code_verifier`) for tokens at the token endpoint.
 *  3. VERIFY the ID token (signature/`iss`/`aud`/`exp`/`iat`/`nonce`) — RT-03.
 *  4. Map verified claims → session via {@link sessionFromOidcClaims}.
 *  5. ROTATE any pre-existing (pre-auth) session id, else issue fresh — RT-05
 *     anti-fixation: a token a victim held before login can never be reused.
 *  6. Set the `__Host-session` cookie; return the CSRF token in the body.
 *
 * Any verification/exchange failure → uniform `401` (no leak of which check
 * failed), and the transaction cookie is always cleared.
 */
export function callbackHandler(config: AuthRoutesConfig): MiddlewareHandler {
  const sessionOpts: OidcSessionOptions = config.session
  const cookieName = sessionOpts.cookieName ?? DEFAULT_SESSION_COOKIE_NAME

  const handler: MiddlewareHandler = async (c) => {
    const code = c.req.query('code')
    const returnedState = c.req.query('state')

    // Recover this transaction's id from the returned `state` (`<txid>.<random>`)
    // and read back ONLY its own cookie (AUTH-SESSION-05) — concurrent logins no
    // longer evict each other. A missing/malformed state has no txid → fail closed.
    const txid = typeof returnedState === 'string' ? txidFromState(returnedState) : null
    const tx = txid ? await readTransactionCookie(c, config, txid) : null
    // The transaction cookie is single-use — clear it no matter the outcome.
    if (txid) clearTransactionCookie(c, config, txid)

    if (!tx || typeof code !== 'string' || code.length === 0) {
      return uniform401(c)
    }
    // State binding — defeats login-CSRF / forged callbacks.
    if (typeof returnedState !== 'string' || returnedState !== tx.state) {
      return uniform401(c)
    }

    let claims: VerifiedClaims
    try {
      const tokens = await exchangeCode(config, code, tx.codeVerifier)
      const verifier = config.verifier ?? (await createOidcVerifier(config.oidc))
      // Nonce binding (RT-03) — the verifier rejects a mismatched/absent nonce.
      claims = await verifier.verify(tokens.id_token as string, { nonce: tx.nonce })
    } catch {
      return uniform401(c)
    }

    // RT-05: if a pre-auth session id is already present (fixation vector),
    // rotate it; the rotation deletes the old id so it can't be reused. Else
    // issue fresh. Either path mints a NEW id + NEW CSRF token on this
    // anonymous→authenticated privilege change.
    const existingSid = readExistingSessionId(c, cookieName)
    const issued = existingSid
      ? await rotateOidcSession(config, existingSid, claims, sessionOpts)
      : await sessionFromOidcClaims(config.store, claims, config.mapPermissions, sessionOpts)

    // Set the __Host-session cookie (AUTH-03/06).
    c.header('Set-Cookie', issued.cookie, { append: true })

    const result: CallbackResult = { ok: true, csrfToken: issued.csrfToken }
    if (tx.returnTo) result.returnTo = tx.returnTo
    return c.json(result)
  }
  Object.defineProperty(handler, 'name', { value: 'oidcCallback' })
  return handler
}

/**
 * Map verified claims → principal (via {@link sessionFromOidcClaims}'s logic) but
 * ROTATE over an existing session id rather than issuing standalone (RT-05). We
 * re-derive the principal here so rotation reuses the exact same claim→principal
 * mapping as the issue path, then call {@link rotateSession} to delete the old id.
 */
async function rotateOidcSession(
  config: AuthRoutesConfig,
  oldSessionId: string,
  claims: VerifiedClaims,
  opts: OidcSessionOptions,
): Promise<IssuedSession> {
  // Build the principal via the SHARED mapping helper so the rotate path cannot
  // diverge from the fresh-issue path — notably the non-empty tenant-claim check
  // (AUTHZ-07): an empty-string tenant claim yields tenantId=undefined on both.
  const principal = principalFromOidcClaims(claims, config.mapPermissions, opts)
  return rotateSession(config.store, oldSessionId, principal, opts)
}

/** Read the pre-auth session id from the request cookie, if any (RT-05). */
function readExistingSessionId(c: Context, cookieName: string): string | undefined {
  const sid = getCookie(c, cookieName)
  return typeof sid === 'string' && sid.length > 0 ? sid : undefined
}

// ---------------------------------------------------------------------------
// logoutHandler — delete the session + clear the cookie.
// ---------------------------------------------------------------------------

/**
 * `POST` logout. Deletes the server-side session (revocation, AUTH-04) and
 * clears the `__Host-session` cookie. Idempotent — a missing/absent session is a
 * `204` either way (no "were you logged in?" signal). State-changing, so mount it
 * behind the CSRF check like any other cookie-authed mutation.
 */
export function logoutHandler(config: AuthRoutesConfig): MiddlewareHandler {
  const cookieName = config.session.cookieName ?? DEFAULT_SESSION_COOKIE_NAME
  const sameSite = config.session.sameSite ?? 'Lax'
  const handler: MiddlewareHandler = async (c) => {
    const sid = readExistingSessionId(c, cookieName)
    if (sid) await config.store.delete(sid)
    // Clear the cookie: same attributes, empty value, immediate expiry.
    c.header('Set-Cookie', `${buildSessionCookie(cookieName, '', sameSite)}; Max-Age=0`, {
      append: true,
    })
    return c.body(null, 204)
  }
  Object.defineProperty(handler, 'name', { value: 'oidcLogout' })
  return handler
}

// ---------------------------------------------------------------------------
// csrfTokenHandler — return the authenticated session's CSRF token.
// ---------------------------------------------------------------------------

/**
 * `GET /csrf-token`. Returns the CSRF synchronizer token for the current
 * authenticated session (SPA double-submit; closes the `csrf.ts` `/csrf-token`
 * reference and RT-04). MUST be mounted AFTER `authenticate` so `c.get('session')`
 * is populated; an unauthenticated request gets a uniform `401`.
 */
export function csrfTokenHandler(): MiddlewareHandler {
  const handler: MiddlewareHandler = async (c) => {
    const session = c.get('session') as { csrfToken?: string } | undefined
    if (!session || typeof session.csrfToken !== 'string') {
      return uniform401(c)
    }
    return c.json({ csrfToken: session.csrfToken })
  }
  Object.defineProperty(handler, 'name', { value: 'csrfToken' })
  return handler
}

// ---------------------------------------------------------------------------
// Shared uniform 401 (AUTH-10 parity — no leak of which check failed).
// ---------------------------------------------------------------------------

function uniform401(c: Context): Response {
  return c.json({ code: 'Unauthorized' }, 401)
}

// Re-export the verifier-builder so an integrator can construct + cache the
// `verifier` once and pass it into `AuthRoutesConfig` (keeps the JWKS cache warm).
export { createOidcVerifier } from './oidc.js'
export type { AuthConfig }
