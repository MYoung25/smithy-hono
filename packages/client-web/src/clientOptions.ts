/**
 * `browserClientOptions` — the one-liner bridge from a {@link BrowserSession} to
 * the GENERATED typed client.
 *
 * The generated `createXyzClient(opts)` accepts exactly `{ baseUrl?, fetch?,
 * headers? }`. This produces that object pre-wired:
 *   - `fetch`   — a {@link createCredentialedFetch} (credentials + CSRF + retry).
 *   - `headers` — the session's CSRF header on every request.
 *
 *   const client = createNotesClient(browserClientOptions(session))
 *
 * Same-origin (the recommended topology) needs no `baseUrl`; pass one only when
 * the SPA is deployed on a different origin than the API (cross-origin — which
 * also requires the server's CORS allowlist + `SameSite=None` session cookie;
 * see docs/consuming/frontend-deployment.md).
 */

import { createCredentialedFetch } from './fetch.js'
import type { BrowserSession } from './session.js'
import type { FetchLike } from './types.js'

/** The options object the generated client factory accepts. */
export interface BrowserClientOptions {
  baseUrl?: string
  fetch: FetchLike
  headers: () => Promise<Record<string, string>>
}

export interface BrowserClientOptionsConfig {
  /** Prepended to every request path — only needed for a cross-origin SPA. */
  baseUrl?: string
  /** Underlying fetch (default `globalThis.fetch`); injected in tests. */
  fetch?: FetchLike
}

/** Build the generated-client options object from a session. */
export function browserClientOptions(
  session: BrowserSession,
  config: BrowserClientOptionsConfig = {},
): BrowserClientOptions {
  const fetch = createCredentialedFetch(session, config.fetch ? { fetch: config.fetch } : {})
  const options: BrowserClientOptions = {
    fetch,
    headers: () => session.authHeaders(),
  }
  if (config.baseUrl !== undefined) options.baseUrl = config.baseUrl
  return options
}
