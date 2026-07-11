---
id: frontend-deployment
title: Deploying the frontend
sidebar_label: Frontend deployment
sidebar_position: 4
---

# Deploying the frontend

The [deployment](./deployment.md) guide gets your **API** to production. This one
gets the **browser app that consumes it** there too — and, more importantly, wires
its authentication correctly. The codegen already emits a browser-ready typed
client (`generated/*.client.gen.ts`); `@smithy-hono/client-web`
drives the OIDC cookie-session flow and feeds it into that client.

There is exactly **one decision** that drives everything else, and the security
pipeline was designed around it:

> **Is the frontend served from the same origin as the API, or a different one?**

## The decision: same-origin vs cross-origin

| | **Same-origin** (recommended) | **Cross-origin** |
| --- | --- | --- |
| Topology | SPA served from / routed through the API's origin (`https://app.example.com` serves both the UI and `/auth`, `/notes`, …) | SPA on a separate host (`https://app.example.com`) calling the API on another (`https://api.example.com`) |
| Session cookie | `__Host-session`, `SameSite=Lax` | `__Host-session`, **`SameSite=None; Secure`** |
| CORS | **none** | server allowlist required (`config.allowedOrigins`) + credentialed CORS |
| CSRF | synchronizer token (always) | synchronizer token (always) — and now the **only** browser-provenance defense |
| Client `baseUrl` | omit (relative paths) | set to the API origin |
| Failure modes | fewest moving parts | preflights, third-party-cookie policies, `SameSite=None` exposure |

**Prefer same-origin.** It is not just less config — it is *more secure*. With a
same-site session cookie, `SameSite=Lax` is a free second line of defense and
third-party-cookie deprecation in browsers never touches you. Cross-origin forces
`SameSite=None`, which removes that layer and leans the **entire** CSRF guarantee
on the synchronizer token (which smithy-hono implements correctly — but you have
less depth).

Both topologies use the *same* generated client and the *same*
`@smithy-hono/client-web` helper; only configuration changes.

## How authentication actually flows

The server side already ships, unmounted, in
`security-core/auth/routes.ts`.
Mount the four handlers under `/auth` and the browser helper drives them:

```
 browser (SPA)                     your API (Hono + security-core)        IdP (OIDC)
 ─────────────                     ──────────────────────────────        ──────────
 session.login('/x')  ──GET /auth/login──►  302 + __Host-oidc-tx cookie ──►  authorize
                                                                              │
   ◄───────────────────────────  302 back to redirect_uri ?code&state ◄──────┘
 session.completeLogin() ─GET /auth/callback?code&state─► verify id_token,
                                              rotate+issue session, Set-Cookie
                                              __Host-session, { csrfToken }
   (token held in memory)
 client.CreateX(...) ──POST /x  (cookie + X-CSRF-Token)──►  authenticate → csrf → handler
```

- The session cookie is **`HttpOnly`** — JS never reads it. The browser proves
  identity just by *sending* it (`credentials: 'include'`, which `client-web`'s
  fetch sets). The only thing the SPA holds is the readable **CSRF token**, in
  memory (never `localStorage`, never a readable cookie).
- A token **rotation** mints a fresh CSRF token server-side; `client-web` detects
  the resulting `403 { code: 'CsrfFailed' }`, re-fetches the token, and retries
  once — invisibly.

```ts
import { createBrowserSession, browserClientOptions } from '@smithy-hono/client-web'
import { createNotesClient } from './generated/notes.client.gen'

const session = createBrowserSession()                 // same-origin defaults
await session.completeLogin()                          // on the callback landing
if (session.status !== 'authenticated') await session.refresh()  // recover on reload

const notes = createNotesClient(browserClientOptions(session))   // ← cross-origin: ({ baseUrl })
await notes.CreateNote({ body: { text: 'hi' } })       // cookie + CSRF, automatic
```

> **You still need an OIDC IdP.** smithy-hono validates tokens; it does not host a
> login UI (by design — see [auth-design](../reference/auth-design.md)). Point
> `AuthRoutesConfig` at any compliant IdP (Auth0, Entra ID, Keycloak, Cognito,
> Better Auth, …). Without one, the login leg cannot complete — which is why the
> end-to-end login is exercised by `client-web`'s tests against an in-process fake
> backend, not by the deployment smoke.

## Platform matrix

Each row pairs a frontend host with an API target from
[deployment](./deployment.md). The same-origin rows need **no CORS and no
`SameSite=None`**.

| Frontend host | Origin model | Pairs with | Reference |
| --- | --- | --- | --- |
| **nginx container** (k8s) | same-origin (nginx proxies `/auth` + resources to the API Service) | Node / k8s | `deploy/node-web` ✅ built |
| **Cloudflare Worker assets** | same-origin (assets-first, fall through to the Hono router) | Cloudflare | `deploy/cf-crud` (the `[assets]` block) |
| **S3 + CloudFront** | same-origin (a `/api/*` cache behavior → the Lambda origin) | AWS Lambda | sketch below |
| **Any static host / CDN** (Pages, Netlify, …) | **cross-origin** | any | sketch below |

### Same-origin on Node / k8s — `deploy/node-web`

An nginx container that serves the built SPA and reverse-proxies `/auth/*` + your
resource routes to the `smithy-hono-node:3000` Service, fronted by a single
TLS-terminating Ingress. The browser sees one origin. This is the worked,
container-verified reference — see its
README.
`__Host-` cookies require https, so TLS **must** terminate at the Ingress, which
sets `X-Forwarded-Proto: https` for the pipeline's `assertHttps` check.

### Same-origin on Cloudflare

The Worker serves the SPA from `[assets]` and falls through to the Hono router on
a miss — `deploy/cf-crud` already does exactly this (with no auth). Add the
mounted `/auth/*` routes and the security pipeline to make it the secured variant;
the browser stays same-origin throughout.

### Same-origin on AWS via CloudFront

Put the SPA in S3 behind CloudFront, and add a **cache behavior** routing
`/auth/*` and your resource paths to the API Gateway / Lambda origin (with
forwarding of cookies + the CSRF header, caching disabled on those paths). The
browser talks only to the CloudFront domain → same-origin. (No in-repo reference
yet — wire it as a second origin + behavior on the `deploy/aws` stack.)

### Cross-origin (separate CDN host)

When the SPA genuinely must live on a different origin:

1. **Client:** `browserClientOptions(session, { baseUrl: 'https://api.example.com' })`.
2. **CORS:** set `config.allowedOrigins` to the SPA origin; the pipeline's `cors`
   phase echoes that specific origin with `Access-Control-Allow-Credentials: true`
   (never `*`). Credentialed cross-origin requests require the exact origin.
3. **Session cookie:** `session.sameSite: 'None'` (the cookie is sent on
   cross-site requests; it is always `Secure`). This is the one knob that makes
   the synchronizer token the sole CSRF gate — which is fine, because it is the
   real control, but understand you have given up the `Lax` depth.
4. **CSRF delivery:** unchanged — the token comes back in the callback body, lives
   in SPA memory, and rides the `X-CSRF-Token` header. (Do **not** use the
   optional readable-cookie delivery cross-origin.)

## Checklist

- [ ] Auth routes mounted under `/auth` on the API (`loginHandler`,
      `callbackHandler`, `csrfTokenHandler`, `logoutHandler`).
- [ ] An OIDC IdP configured in `AuthRoutesConfig`.
- [ ] TLS terminates at the public edge (required for `__Host-` cookies).
- [ ] SPA calls `completeLogin()` on its callback route and `refresh()` on boot.
- [ ] Generated client built from `browserClientOptions(session)`.
- [ ] **Cross-origin only:** `allowedOrigins` set, session cookie `SameSite=None`,
      client `baseUrl` set.
