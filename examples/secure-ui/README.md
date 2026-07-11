# secure-ui — the browser SPA for `@smithy-hono/client-web`

The end-to-end browser example for [`@smithy-hono/client-web`](../../packages/client-web):
a React + Vite + Tailwind single-page app that drives the **OIDC cookie-session
flow** against the [`secure-api`](../secure-api) reference service and talks to its
generated `/notes` resource through the **generated types** — with the session
cookie, the CSRF synchronizer token, and the automatic refresh-and-retry on CSRF
rotation all wired in by `client-web`.

It is the SPA half of the topology the security-core auth routes were built for; the
server half (`loginHandler` / `callbackHandler` / `csrfTokenHandler` / `logoutHandler`)
is already mounted in [`secure-api/src/createApp.ts`](../secure-api/src/createApp.ts).

---

## What it does

On boot the app:

1. calls `session.completeLogin()` — finishes a login if the page was just loaded on
   the IdP callback landing (`?code&state` present), capturing the CSRF token in memory;
2. otherwise calls `session.refresh()` — recovers the CSRF token from an existing
   `__Host-session` cookie after a reload (or learns it is anonymous);
3. renders a **Log in** button when anonymous (`session.login(location.pathname)` →
   full-page redirect to the IdP), or the **notes list + create form + Log out** button
   when authenticated.

Every `/notes` call goes through the typed client built from
`browserClientOptions(session)` (see [`src/notesClient.ts`](./src/notesClient.ts)), so
each request automatically carries `credentials: 'include'` and the `X-CSRF-Token`
header, and retries once if the server rotates the token.

---

## How it consumes the two packages (no tarball / no codegen copy)

- **`@smithy-hono/client-web`** — consumed via a Vite `resolve.alias` mapping the bare
  specifier to the package's already-built `dist` (plus a matching `tsconfig.json`
  `paths` entry for `tsc`). No npm tarball, no lockfile machinery, nothing the root
  build / CI touches. **Build the package's dist once first:**

  ```bash
  npm -w @smithy-hono/client-web run build
  ```

- **The generated secure-api types** (`Note`, `CreateNoteBody`, …) — imported by
  RELATIVE PATH (`../../secure-api/generated/notes.gen`) as a **type-only** import, so
  nothing is copied and the generated router's `hono`/`zod` imports never enter this
  bundle. `src/notesClient.ts` then plays the role the README's
  `createNotesClient(browserClientOptions(session))` would, exposing the five note ops
  with those generated types.

> The CSRF-token route in secure-api is mounted at **`/csrf-token`** (not the
> client-web default `/auth/csrf-token`), so the SPA overrides `csrfPath` when it
> creates the session — see [`src/App.tsx`](./src/App.tsx). Login / callback / logout
> sit under `/auth`, matching the client-web defaults.

---

## Running it locally

### 1. Start the secure-api dev server (in-memory, no Redis)

```bash
cd ../secure-api
npm install
npm run dev          # boots src/devServer.ts on http://localhost:3000
```

The dev server uses **in-memory** security stores and is **OIDC env-gated**:

- With the `OIDC_*` env vars set (see below), it builds a real remote-JWKS verifier and
  a full login works against your IdP.
- Without them, it logs a one-line notice and mounts the auth routes against
  **placeholder** endpoints + a fake verifier so the server still boots and serves the
  SPA. In that mode `/auth/login` redirects to a non-existent IdP — a **full login is
  not exercisable without a real OIDC provider** (this is expected; the auth routes are
  wired and compile, but cannot be driven end-to-end without an IdP).

`OIDC_*` env for a real login (all of them, or none → fake fallback):

```
OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_REDIRECT_URI, OIDC_AUTHORIZE_URL,
OIDC_TOKEN_URL, OIDC_STATE_SECRET            (OIDC_CLIENT_SECRET optional for PKCE)
```

> `OIDC_REDIRECT_URI` should point back at the SPA's callback landing — in dev,
> `http://localhost:5173/auth/callback` (Vite proxies `/auth/*` to secure-api).

### 2. Start this SPA

```bash
cd ../secure-ui
npm install
npm run dev          # Vite on http://localhost:5173
```

Vite proxies `/auth`, `/notes`, and `/csrf-token` to `http://localhost:3000`, so the
browser talks **same-origin** — no CORS needed in dev. Open
[http://localhost:5173](http://localhost:5173).

### 3. Build

```bash
npm run build        # tsc --noEmit && vite build
```

---

## Offline / no-IdP development

A full OIDC login genuinely needs an IdP — there is no honest way around that. But you
do **not** need this SPA + a live IdP to develop against `client-web`:
`@smithy-hono/client-web` ships an in-process fake backend for exactly this. From a test:

```ts
import { createBrowserSession } from '@smithy-hono/client-web'
import { createFakeAuthBackend } from '@smithy-hono/client-web/test-support'

const backend = createFakeAuthBackend()
const session = createBrowserSession({ fetch: backend.fetch /* + a fake location */ })
```

That drives the full login / refresh / logout / CSRF-rotation flow with no IdP,
network, or cookie jar — see the package's own `*.test.ts`. Use it to build and test
your login/logout/error UI; use this SPA + a real IdP for the genuine end-to-end run.
