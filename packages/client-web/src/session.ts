/**
 * `createBrowserSession` — the SPA-side counterpart to security-core's
 * `auth/routes.ts` handlers (`loginHandler` / `callbackHandler` /
 * `csrfTokenHandler` / `logoutHandler`).
 *
 * THE FLOW (same-origin is the recommended topology; see
 * docs/consuming/frontend-deployment.md):
 *   1. `login(returnTo)`     — full-page navigate to the mounted `GET /auth/login`,
 *                              which 302s to the IdP (PKCE/state in a signed
 *                              transaction cookie). OIDC requires a top-level
 *                              navigation, so this is NOT a fetch.
 *   2. IdP → redirect_uri    — the browser lands back on the SPA callback page
 *                              with `?code&state`.
 *   3. `completeLogin()`     — fetch the mounted `GET /auth/callback` + that query
 *                              (`credentials: 'include'` so the transaction cookie
 *                              rides along); the server verifies the ID token,
 *                              sets the `__Host-session` cookie, and returns
 *                              `{ csrfToken, returnTo }`. We stash the token in
 *                              MEMORY (never a readable cookie / localStorage) and
 *                              scrub `code`/`state` from the URL.
 *   4. `refresh()`           — on a later reload the `__Host-session` cookie is
 *                              still present but the in-memory token is gone; GET
 *                              `/auth/csrf-token` to recover it (401 ⇒ anonymous).
 *   5. `logout()`            — POST `/auth/logout` with the CSRF header; clear state.
 *
 * The session NEVER reads the `__Host-session` cookie (it is `HttpOnly` — JS can't,
 * by design). Authentication is proven to the server purely by the cookie the
 * browser attaches under `credentials: 'include'`; this object only manages the
 * readable CSRF synchronizer token the server's `csrf` phase demands on writes.
 */

import type { AuthStatus, FetchLike, HistoryLike, LocationLike } from './types.js'

const DEFAULT_AUTH_BASE_PATH = '/auth'
const DEFAULT_CSRF_HEADER = 'X-CSRF-Token'

/** The successful-callback body shape (mirrors security-core `CallbackResult`). */
interface CallbackBody {
  csrfToken?: string
  returnTo?: string
}

/** The `GET /auth/csrf-token` body shape (mirrors security-core `csrfTokenHandler`). */
interface CsrfTokenBody {
  csrfToken?: string
}

export interface BrowserSessionOptions {
  /**
   * Base path the security-core auth routes are mounted under (default `/auth`).
   * The four individual paths below default to `${authBasePath}/{login,callback,
   * csrf-token,logout}`; override any individually if your mount differs.
   */
  authBasePath?: string
  /** `GET` login initiator (302 → IdP). Default `${authBasePath}/login`. */
  loginPath?: string
  /** `GET` callback exchange endpoint we POST the `code` to. Default `${authBasePath}/callback`. */
  callbackPath?: string
  /** `GET` token-recovery endpoint. Default `${authBasePath}/csrf-token`. */
  csrfPath?: string
  /** `POST` logout endpoint. Default `${authBasePath}/logout`. */
  logoutPath?: string
  /** Request header the CSRF token is echoed in. Default `X-CSRF-Token`. */
  csrfHeaderName?: string
  /** `fetch` to use for the auth round-trips. Default `globalThis.fetch`. */
  fetch?: FetchLike
  /** `window.location` (injected in tests). Default `globalThis.location`. */
  location?: LocationLike
  /** `window.history` (injected in tests). Default `globalThis.history`. */
  history?: HistoryLike
  /** Notified on every status / token transition — drive SPA re-render off this. */
  onChange?: (status: AuthStatus, csrfToken: string | null) => void
}

/** The outcome of {@link BrowserSession.completeLogin}. */
export interface CompleteLoginResult {
  /** `true` if a session was established from the callback query. */
  authenticated: boolean
  /** The same-origin path the login initiator asked to return to, if any. */
  returnTo?: string
}

/** Methods the credentialed fetch and the SPA both rely on (the public surface). */
export class BrowserSession {
  readonly csrfHeaderName: string

  private readonly loginPath: string
  private readonly callbackPath: string
  private readonly csrfPath: string
  private readonly logoutPath: string
  private readonly fetch: FetchLike
  private readonly location: LocationLike
  private readonly history: HistoryLike | undefined
  private readonly onChange: ((status: AuthStatus, csrfToken: string | null) => void) | undefined

  private _status: AuthStatus = 'unknown'
  private _csrfToken: string | null = null

  constructor(opts: BrowserSessionOptions = {}) {
    const base = opts.authBasePath ?? DEFAULT_AUTH_BASE_PATH
    this.loginPath = opts.loginPath ?? `${base}/login`
    this.callbackPath = opts.callbackPath ?? `${base}/callback`
    this.csrfPath = opts.csrfPath ?? `${base}/csrf-token`
    this.logoutPath = opts.logoutPath ?? `${base}/logout`
    this.csrfHeaderName = opts.csrfHeaderName ?? DEFAULT_CSRF_HEADER
    this.fetch = opts.fetch ?? defaultFetch()
    this.location = opts.location ?? (globalThis as { location?: LocationLike }).location!
    this.history = opts.history ?? (globalThis as { history?: HistoryLike }).history
    this.onChange = opts.onChange
  }

  /** Coarse auth state — `'unknown'` until the first `completeLogin`/`refresh`. */
  get status(): AuthStatus {
    return this._status
  }

  /** The current in-memory CSRF token, or `null` when anonymous. */
  getCsrfToken(): string | null {
    return this._csrfToken
  }

  /**
   * Start login: full-page navigate to the mounted login initiator. `returnTo`
   * (a same-origin path) is preserved through the IdP round-trip and echoed back
   * by the callback. This NAVIGATES AWAY — nothing after it runs.
   */
  login(returnTo?: string): void {
    const url = new URL(this.loginPath, this.location.origin)
    if (returnTo) url.searchParams.set('returnTo', returnTo)
    this.location.href = url.toString()
  }

  /**
   * Complete login when the SPA is loaded on the callback landing (`?code&state`
   * present). Fetches the callback endpoint with the query (credentials included
   * so the transaction cookie rides along), captures the CSRF token in memory,
   * and scrubs `code`/`state` from the address bar. A no-op (`authenticated:
   * false`) when there is no callback query — safe to call unconditionally on boot.
   */
  async completeLogin(): Promise<CompleteLoginResult> {
    const query = this.location.search
    const params = new URLSearchParams(query)
    if (!params.has('code') || !params.has('state')) {
      return { authenticated: false }
    }

    let res: Response
    try {
      res = await this.fetch(joinPathAndQuery(this.callbackPath, query), {
        method: 'GET',
        credentials: 'include',
        headers: { accept: 'application/json' },
      })
    } catch {
      this.set('anonymous', null)
      return { authenticated: false }
    }

    if (!res.ok) {
      this.set('anonymous', null)
      return { authenticated: false }
    }
    const body = (await safeJson<CallbackBody>(res)) ?? {}
    if (typeof body.csrfToken !== 'string' || body.csrfToken.length === 0) {
      this.set('anonymous', null)
      return { authenticated: false }
    }

    this.set('authenticated', body.csrfToken)
    const returnTo = sameOriginPath(body.returnTo, this.location.origin)
    this.scrubCallbackUrl(returnTo)
    return returnTo ? { authenticated: true, returnTo } : { authenticated: true }
  }

  /**
   * Recover the in-memory CSRF token from an existing `__Host-session` cookie
   * (e.g. after a page reload), or learn we are anonymous. Also called by the
   * credentialed fetch to recover from a server-side token rotation. Returns
   * `true` while still authenticated.
   */
  async refresh(): Promise<boolean> {
    let res: Response
    try {
      res = await this.fetch(this.csrfPath, {
        method: 'GET',
        credentials: 'include',
        headers: { accept: 'application/json' },
      })
    } catch {
      this.set('anonymous', null)
      return false
    }
    if (!res.ok) {
      this.set('anonymous', null)
      return false
    }
    const body = (await safeJson<CsrfTokenBody>(res)) ?? {}
    if (typeof body.csrfToken !== 'string' || body.csrfToken.length === 0) {
      this.set('anonymous', null)
      return false
    }
    this.set('authenticated', body.csrfToken)
    return true
  }

  /**
   * Log out: POST the logout endpoint with the CSRF header (it is a
   * state-changing, cookie-authed request, so the server's `csrf` phase guards
   * it), then drop to anonymous regardless of the response (idempotent server-side).
   */
  async logout(): Promise<void> {
    const headers: Record<string, string> = {}
    if (this._csrfToken) headers[this.csrfHeaderName] = this._csrfToken
    try {
      await this.fetch(this.logoutPath, { method: 'POST', credentials: 'include', headers })
    } catch {
      // Best-effort: a failed network call still clears local state below.
    } finally {
      this.set('anonymous', null)
    }
  }

  /**
   * The headers to merge into every generated-client request — just the CSRF
   * token when authenticated (the server ignores it on safe methods, so attaching
   * it unconditionally is harmless). Spread by {@link browserClientOptions} into
   * the client's `headers()` hook.
   */
  async authHeaders(): Promise<Record<string, string>> {
    return this._csrfToken ? { [this.csrfHeaderName]: this._csrfToken } : {}
  }

  private set(status: AuthStatus, csrfToken: string | null): void {
    const changed = status !== this._status || csrfToken !== this._csrfToken
    this._status = status
    this._csrfToken = csrfToken
    if (changed) this.onChange?.(status, csrfToken)
  }

  /** Remove `code`/`state` from the URL (replaceState to `returnTo` ?? pathname). */
  private scrubCallbackUrl(returnTo: string | undefined): void {
    if (!this.history) return
    const target = returnTo ?? this.location.pathname
    try {
      this.history.replaceState(null, '', target)
    } catch {
      // Non-DOM / restricted history — the token is already captured; ignore.
    }
  }
}

/** Construct a {@link BrowserSession}. */
export function createBrowserSession(opts: BrowserSessionOptions = {}): BrowserSession {
  return new BrowserSession(opts)
}

// ---------------------------------------------------------------------------
// Local helpers (Web-standard only).
// ---------------------------------------------------------------------------

function defaultFetch(): FetchLike {
  const f = (globalThis as { fetch?: FetchLike }).fetch
  if (!f) throw new Error('createBrowserSession: no global fetch; pass opts.fetch')
  return f.bind(globalThis) as FetchLike
}

/** Append a `?...` query string to a path that may already carry one. */
function joinPathAndQuery(path: string, query: string): string {
  if (!query || query === '?') return path
  const q = query.startsWith('?') ? query.slice(1) : query
  return path.includes('?') ? `${path}&${q}` : `${path}?${q}`
}

/**
 * Only honor a same-origin PATH as `returnTo` (open-redirect defense). Resolve the
 * candidate against the page origin with the WHATWG URL parser and accept it only
 * if it stays on this origin — a character-prefix check is not enough, since the
 * parser normalizes `\` to `/`, so `/\evil.com` (and `//evil.com`, `https://evil`,
 * `javascript:` …) all escape a naive `startsWith('/')` filter. Returning the
 * resolved path+search+hash means a downstream `location.assign` cannot escape.
 */
function sameOriginPath(returnTo: string | undefined, origin: string): string | undefined {
  if (typeof returnTo !== 'string') return undefined
  try {
    const u = new URL(returnTo, origin)
    return u.origin === origin ? u.pathname + u.search + u.hash : undefined
  } catch {
    return undefined
  }
}

async function safeJson<T>(res: Response): Promise<T | undefined> {
  try {
    return (await res.json()) as T
  } catch {
    return undefined
  }
}
