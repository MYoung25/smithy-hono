/**
 * In-process fake of the security-core auth routes + a CSRF-guarded resource,
 * for testing the browser helper without a real IdP, network, or cookie jar.
 *
 * It models the server contract `client-web` pairs with — `GET /auth/callback`
 * (establish session, return `{ csrfToken, returnTo }`), `GET /auth/csrf-token`
 * (recover the token), `POST /auth/logout`, and a state-changing `POST /things`
 * that demands a matching `X-CSRF-Token` — so the same fake validates the helper
 * AND seeds a consumer's own tests (exported from `./test-support`).
 *
 * Cookies are SIMULATED: a real browser would round-trip `__Host-session` via
 * `credentials: 'include'`; here there is no cookie jar, so the fake holds a
 * single server-side session and treats every request as that one browser. That
 * is enough to exercise token capture, header attachment, and rotation-retry —
 * the logic this package owns. (End-to-end cookie behavior is covered by the
 * real-server example + the deploy smoke.)
 */

import type { FetchLike } from './types.js'

export interface FakeAuthBackendOptions {
  /** Auth route base path (must match the session's `authBasePath`). Default `/auth`. */
  authBasePath?: string
  /** The `code` the callback accepts as valid. Default `'valid-code'`. */
  validCode?: string
  /** The path of the CSRF-guarded test resource. Default `/things`. */
  resourcePath?: string
}

export interface FakeAuthBackend {
  /** The {@link FetchLike} to pass as `opts.fetch` to the session / client. */
  fetch: FetchLike
  /** Force a server-side CSRF-token rotation (the next stale write 403s once). */
  rotateCsrfToken(): void
  /** The current server-side CSRF token (`null` when no session). */
  currentCsrfToken(): string | null
  /** `true` once a session has been established and not logged out. */
  isAuthenticated(): boolean
  /** Count of accepted writes to the guarded resource (assert side effects). */
  acceptedWrites(): number
}

/** Build a stateful fake auth backend + guarded resource. */
export function createFakeAuthBackend(opts: FakeAuthBackendOptions = {}): FakeAuthBackend {
  const base = opts.authBasePath ?? '/auth'
  const validCode = opts.validCode ?? 'valid-code'
  const resourcePath = opts.resourcePath ?? '/things'

  let session: { csrfToken: string } | null = null
  let tokenSeq = 0
  let writes = 0

  const mintToken = (): string => `csrf-token-${++tokenSeq}`
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })

  const fetch: FetchLike = async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const url = new URL(input, 'http://fake.local')
    const path = url.pathname

    // GET /auth/callback?code&state — establish a session, return the CSRF token.
    if (path === `${base}/callback` && method === 'GET') {
      const code = url.searchParams.get('code')
      if (code !== validCode) return json({ code: 'Unauthorized' }, 401)
      session = { csrfToken: mintToken() }
      const returnTo = url.searchParams.get('returnTo') ?? undefined
      const body: { ok: true; csrfToken: string; returnTo?: string } = {
        ok: true,
        csrfToken: session.csrfToken,
      }
      if (returnTo) body.returnTo = returnTo
      return json(body)
    }

    // GET /auth/csrf-token — recover the token for an existing session.
    if (path === `${base}/csrf-token` && method === 'GET') {
      if (!session) return json({ code: 'Unauthorized' }, 401)
      return json({ csrfToken: session.csrfToken })
    }

    // POST /auth/logout — revoke the session (idempotent 204).
    if (path === `${base}/logout` && method === 'POST') {
      session = null
      return new Response(null, { status: 204 })
    }

    // POST /things — a CSRF-guarded, cookie-authed write.
    if (path === resourcePath && method === 'POST') {
      if (!session) return json({ code: 'Unauthorized' }, 401)
      const provided = new Headers(init?.headers).get('X-CSRF-Token')
      if (provided !== session.csrfToken) return json({ code: 'CsrfFailed' }, 403)
      writes++
      return json({ ok: true }, 201)
    }

    // GET /things — a safe read (no CSRF required), proves cookie-only access.
    if (path === resourcePath && method === 'GET') {
      if (!session) return json({ code: 'Unauthorized' }, 401)
      return json({ items: [] })
    }

    return json({ code: 'NotFound' }, 404)
  }

  return {
    fetch,
    rotateCsrfToken() {
      if (session) session = { csrfToken: mintToken() }
    },
    currentCsrfToken: () => session?.csrfToken ?? null,
    isAuthenticated: () => session !== null,
    acceptedWrites: () => writes,
  }
}
