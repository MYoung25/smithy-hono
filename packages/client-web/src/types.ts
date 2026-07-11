/**
 * Shared structural types for the browser auth helper.
 *
 * `FetchLike` is intentionally the SAME shape the generated client and
 * `@smithy-hono/test-kit` accept, so a session-wired fetch drops straight into
 * `createXyzClient({ fetch })`.
 */

/** The `fetch`-shaped function the generated client accepts (and that we wrap). */
export interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>
}

/** Coarse auth state a single-page app renders off (login button vs. app shell). */
export type AuthStatus = 'unknown' | 'anonymous' | 'authenticated'

/**
 * The slice of `window.location` the session needs. Injected in tests; defaults
 * to `globalThis.location` in the browser. `href` is writable so {@link
 * BrowserSession.login} can perform the full-page navigation OIDC requires.
 */
export interface LocationLike {
  readonly origin: string
  readonly pathname: string
  readonly search: string
  href: string
}

/** The slice of `window.history` the session needs (URL scrub after callback). */
export interface HistoryLike {
  replaceState(data: unknown, unused: string, url?: string | null): void
}

/**
 * The minimal CSRF surface {@link createCredentialedFetch} reads off a session —
 * so the fetch wrapper depends on this structural shape, not the concrete class.
 */
export interface CsrfSource {
  /** The current in-memory CSRF synchronizer token, or `null` when anonymous. */
  getCsrfToken(): string | null
  /** The request header the token is echoed in (default `X-CSRF-Token`). */
  readonly csrfHeaderName: string
  /** Re-fetch the token after a server-side rotation; `true` if still authenticated. */
  refresh(): Promise<boolean>
}
