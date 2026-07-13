# @smithy-hono/client-web

The browser-side counterpart to
[`@smithy-hono/security-core`](../security-core)'s OIDC cookie-session flow.
It drives the four `auth/routes.ts` handlers from a single-page app and wires the
result into the **generated typed client** via that client's two injection points
(`fetch` and `headers`) — so a cookie-authenticated SPA "just works" with
`credentials: 'include'`, the CSRF synchronizer token, and transparent recovery
from token rotation.

Web-standard only (ARCH-01): `fetch` / `URL` / `History` / `Location`. **No
`hono`, no `node:*`, no SDK, zero runtime dependencies.** It runs in any browser
bundle (Vite, etc.).

## Install

```bash
npm install @smithy-hono/client-web
```

## The flow it drives

It pairs 1:1 with the security-core handlers (mount them under `/auth` — see the
secure-api example):

| SPA call | Server handler | What happens |
| --- | --- | --- |
| `session.login(returnTo)` | `loginHandler` (`GET /auth/login`) | full-page redirect to the IdP (PKCE/state in a signed cookie) |
| `session.completeLogin()` | `callbackHandler` (`GET /auth/callback`) | verify ID token, set `__Host-session` cookie, return `{ csrfToken }` |
| `session.refresh()` | `csrfTokenHandler` (`GET /auth/csrf-token`) | recover the in-memory token after a reload |
| `session.logout()` | `logoutHandler` (`POST /auth/logout`) | revoke the session + clear the cookie |

The session **never reads the `__Host-session` cookie** — it is `HttpOnly` by
design. Authentication is proven to the server purely by the cookie the browser
attaches under `credentials: 'include'`; this library only manages the readable
CSRF synchronizer token the server's `csrf` phase demands on writes, holding it
**in memory** (never `localStorage`, never a readable cookie).

## Usage

```ts
import { createBrowserSession, browserClientOptions } from '@smithy-hono/client-web'
import { createNotesClient } from './generated/notes.client.gen'

// 1. One session per app. Defaults assume the auth routes are mounted under /auth.
const session = createBrowserSession({
  onChange: (status) => render(status), // 'unknown' | 'anonymous' | 'authenticated'
})

// 2. On boot: finish a login if we just came back from the IdP, else try to
//    recover an existing session's CSRF token.
const { returnTo } = await session.completeLogin()
if (session.status !== 'authenticated') await session.refresh()
if (returnTo) router.navigate(returnTo)

// 3. A login button:  onClick={() => session.login(location.pathname)}
// 4. A logout button: onClick={() => session.logout()}

// 5. The generated client — credentials + CSRF + retry, wired in one line.
const notes = createNotesClient(browserClientOptions(session))
await notes.CreateNote({ body: { text: 'hi' } })   // cookie + X-CSRF-Token, automatic
```

### CSRF rotation is invisible

A session-id rotation (e.g. a privilege change) mints a fresh CSRF token
server-side, so a write carrying the stale token gets a `403 { code: 'CsrfFailed'
}`. The credentialed fetch detects exactly that response, calls `refresh()`, and
**retries once** with the new token — the app never sees the failure.

### Same-origin vs cross-origin

The defaults assume **same-origin** (the SPA is served from, or routed through,
the API's origin — the recommended topology; see
[deploy/node-web](../../deploy/node-web) and
[docs/consuming/frontend-deployment.md](../../docs/consuming/frontend-deployment.md)).
For a **cross-origin** SPA (separate CDN host), pass `baseUrl` to
`browserClientOptions`, and on the server enable the CORS allowlist and set the
session cookie `SameSite=None`.

## API

- **`createBrowserSession(opts?)` → `BrowserSession`** — `login` / `completeLogin`
  / `refresh` / `logout` / `authHeaders` / `getCsrfToken` / `status`. Configure
  the auth paths (`authBasePath` default `/auth`, or each path individually), the
  `csrfHeaderName` (default `X-CSRF-Token`), and an `onChange` callback. Inject
  `fetch` / `location` / `history` in tests.
- **`browserClientOptions(session, { baseUrl?, fetch? })`** → `{ fetch, headers }`
  to spread into any generated `createXyzClient(...)`.
- **`createCredentialedFetch(session, { fetch? })`** → a `fetch` that adds
  `credentials: 'include'`, the CSRF header on writes, and the rotation-retry — if
  you build the client options yourself.

## Testing your app

The `./test-support` subpath exports `createFakeAuthBackend()` — an in-process
fake of the auth routes plus a CSRF-guarded resource, so you can test your
login/logout/error UI with no IdP, network, or cookie jar:

```ts
import { createFakeAuthBackend } from '@smithy-hono/client-web/test-support'

const backend = createFakeAuthBackend()
const session = createBrowserSession({ fetch: backend.fetch, /* + fake location */ })
```

(For end-to-end cookie behavior, drive the **real** generated client against your
pipeline in-process with [`@smithy-hono/test-kit`](../test-kit).)
