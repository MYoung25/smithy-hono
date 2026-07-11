/**
 * `createCredentialedFetch` — the `fetch` you hand the generated client.
 *
 * It does the two browser-side things the server's security pipeline requires of
 * a cookie-authenticated SPA, neither of which the generated client knows about:
 *
 *   1. `credentials: 'include'` on every request, so the `__Host-session` cookie
 *      (and, same-origin, the transaction cookie) is actually sent. `fetch`
 *      defaults to `same-origin`; cross-origin it would be `omit` — either way
 *      the session cookie would be dropped without this.
 *   2. The CSRF synchronizer token in the `X-CSRF-Token` header on STATE-CHANGING
 *      requests (the server's `csrf` phase rejects cookie-authed writes without
 *      it). Safe methods (GET/HEAD/OPTIONS) are left alone.
 *
 * Rotation recovery (CSRF-*): a session-id rotation (e.g. privilege change) mints
 * a fresh CSRF token server-side, so a write carrying the stale token gets a
 * `403 { code: 'CsrfFailed' }`. On exactly that response we `refresh()` the token
 * and RETRY ONCE — so a rotation is invisible to the app instead of surfacing a
 * spurious failure. Any other 403 (or a refresh that comes back anonymous) is
 * returned untouched.
 */

import type { CsrfSource, FetchLike } from './types.js'

/** Methods the server treats as safe (no CSRF token required). */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export interface CredentialedFetchOptions {
  /** The underlying fetch. Default `globalThis.fetch`. */
  fetch?: FetchLike
}

/**
 * Wrap a fetch so it carries credentials + the session's CSRF token and
 * transparently recovers from a CSRF-token rotation. The `session` only needs to
 * satisfy {@link CsrfSource} (a {@link import('./session.js').BrowserSession} does).
 */
export function createCredentialedFetch(
  session: CsrfSource,
  opts: CredentialedFetchOptions = {},
): FetchLike {
  const baseFetch = opts.fetch ?? defaultFetch()

  return async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const unsafe = !SAFE_METHODS.has(method)

    const res = await baseFetch(input, withCredentials(init, session, unsafe))
    if (!unsafe || res.status !== 403 || !(await isCsrfFailure(res))) {
      return res
    }

    // Stale CSRF token (rotation) — refresh and retry the write exactly once.
    const stillAuthed = await session.refresh()
    if (!stillAuthed) return res
    return baseFetch(input, withCredentials(init, session, unsafe))
  }
}

/**
 * Build a `RequestInit` with `credentials: 'include'` and (for writes) the CSRF
 * header set to the session's CURRENT token. This wrapper is the CSRF authority:
 * it OVERWRITES any token the generated client's `headers()` hook already merged
 * in, which is precisely what makes the rotation-retry below correct — after
 * `refresh()` the session holds the fresh token, and re-running this picks it up
 * even though the original `init.headers` still carries the stale one.
 */
function withCredentials(
  init: RequestInit | undefined,
  session: CsrfSource,
  unsafe: boolean,
): RequestInit {
  const headers = new Headers(init?.headers)
  if (unsafe) {
    const token = session.getCsrfToken()
    if (token) headers.set(session.csrfHeaderName, token)
  }
  return { ...init, headers, credentials: 'include' }
}

/** `true` when the response is the server's CSRF rejection (`{ code: 'CsrfFailed' }`). */
async function isCsrfFailure(res: Response): Promise<boolean> {
  try {
    const body = (await res.clone().json()) as { code?: string }
    return body?.code === 'CsrfFailed'
  } catch {
    return false
  }
}

function defaultFetch(): FetchLike {
  const f = (globalThis as { fetch?: FetchLike }).fetch
  if (!f) throw new Error('createCredentialedFetch: no global fetch; pass opts.fetch')
  return f.bind(globalThis) as FetchLike
}
