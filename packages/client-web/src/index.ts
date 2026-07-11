/**
 * `@smithy-hono/client-web` — drive the security-core OIDC cookie-session flow
 * from a browser SPA and wire it into the generated typed client.
 *
 *   import { createBrowserSession, browserClientOptions } from '@smithy-hono/client-web'
 *   import { createNotesClient } from './generated/notes.client.gen'
 *
 *   const session = createBrowserSession()        // routes mounted under /auth
 *   await session.completeLogin()                 // on the callback landing page
 *   await session.refresh()                       // recover token after a reload
 *   const notes = createNotesClient(browserClientOptions(session))
 *   await notes.CreateNote({ body: { text: 'hi' } })   // cookie + CSRF, automatic
 *
 * Pairs with security-core's `auth/routes.ts` handlers on the server. Web-standard
 * only (ARCH-01) — no `hono`, no `node:*`, no SDK.
 */

export { BrowserSession, createBrowserSession } from './session.js'
export type {
  BrowserSessionOptions,
  CompleteLoginResult,
} from './session.js'

export { createCredentialedFetch } from './fetch.js'
export type { CredentialedFetchOptions } from './fetch.js'

export { browserClientOptions } from './clientOptions.js'
export type {
  BrowserClientOptions,
  BrowserClientOptionsConfig,
} from './clientOptions.js'

export type { AuthStatus, CsrfSource, FetchLike, HistoryLike, LocationLike } from './types.js'
