# Cloudflare (Workers) deployment — secure notes, one command

Deploys the **secure notes reference consumer** to Cloudflare Workers as a single
same-origin full-stack Worker, in **one command** driven by
[`@smithy-hono/deploy-cf`](../../packages/deploy-cf):

- [`examples/secure-api`](../../examples/secure-api) — the seven-layer
  `@smithy-hono/security-core` pipeline + the OIDC cookie-session flow
  (login / callback / logout / CSRF), mounted under **`/api`**, backed by the
  Cloudflare adapter stores (Workers KV sessions + a Durable Object for
  rate-limit / nonce + env HMAC signing material);
- [`examples/secure-ui`](../../examples/secure-ui) — the React SPA, built with
  `VITE_API_BASE=/api` so every auth + notes call is same-origin under the same
  Worker, served as **static assets** (SPA fallback for non-`/api` paths).

The `smithy-hono-deploy` CLI reads [`smithy-deploy.config.mjs`](./smithy-deploy.config.mjs),
provisions the bindings, generates + syncs the secrets, builds the UI, renders
`wrangler.toml` with a custom-domain route, and deploys.

## Prerequisites

- **Workers Paid plan.** This service uses **Durable Objects** (strong-consistency
  rate-limit + nonce stores), which are not on the free plan. (Contrast
  [`deploy/cf-crud`](../cf-crud), which is free-plan friendly.)
- **The domain's zone is added to Cloudflare and its nameservers are delegated.**
  This is the one manual step the CLI cannot do for you: add the domain as a zone
  in the Cloudflare dashboard and point your registrar's nameservers at
  Cloudflare. The deploy then attaches a custom-domain route on
  `https://<domain>`.
- **wrangler ≥ 3.90** (the rendered config uses `run_worker_first` arrays).
- **Auth:** either run `wrangler login`, or set `CLOUDFLARE_API_TOKEN` (and
  `CLOUDFLARE_ACCOUNT_ID`) in the environment.

## Deploy from THIS repo

From the repo root (forwards the domain to the CLI, which `cd`s here first):

```bash
npm run deploy -- <domain>
```

Or run the CLI directly from this directory:

```bash
cd deploy/cf-secure
npx smithy-hono-deploy <domain>
```

Before the first deploy, copy the secrets template and fill in your IdP's
confidential-client secret (or delete the key for a public PKCE client):

```bash
cp deploy.secrets.example.json deploy.secrets.json
# edit deploy.secrets.json
```

Also set your real IdP facts in `smithy-deploy.config.mjs` (`oidc: { issuer,
clientId, authorizeUrl, tokenUrl }`) — the committed values are placeholders.

## Use it in YOUR OWN smithy-hono project

The deploy is config-driven, so you don't copy any of this Worker's plumbing:

```bash
npm i -D @smithy-hono/deploy-cf
```

Add a `smithy-deploy.config.mjs` next to your Worker entry (use
[this one](./smithy-deploy.config.mjs) as the template), then wire a script:

```json
{
  "scripts": {
    "deploy": "smithy-hono-deploy"
  }
}
```

…and run `npm run deploy -- <domain>`.

## Secrets & config: what's auto-generated vs. what you supply

| Value | Source | Notes |
| --- | --- | --- |
| `HMAC_KEY_2026A` | **auto-generated** (`hmac-hex`) | S2S signing key material (lowercase hex). |
| `OIDC_STATE_SECRET` | **auto-generated** (`hmac-base64`) | Signs the login↔callback transaction cookie. |
| `AUDIT_SALT` | **auto-generated** (`random-base64`) | Per-deployment pseudonymization salt (RT-12). |
| `OIDC_CLIENT_SECRET` | **you supply** — `deploy.secrets.json` | Confidential-client secret; omit for public PKCE. |
| `oidc.issuer` / `clientId` / `authorizeUrl` / `tokenUrl` | **you supply** — config `oidc` block | Non-secret IdP facts → Worker `[vars]`. |

`OIDC_REDIRECT_URI` and `ALLOWED_ORIGINS` are derived from the deploy domain
automatically (`https://<domain>/api/auth/callback` and `https://<domain>`).

## Data durability — the notes store is an EPHEMERAL DEMO store

> ⚠️ **The `notes` business data is NOT durable in this reference deploy.**

The deployed Worker ([`src/worker.ts`](./src/worker.ts)) backs the notes with
`createMemoryNotesStore()` — a per-isolate in-memory `Map`. On Cloudflare that
means notes are **recreated on every cold start** and **diverge across the
concurrently-serving isolates/colos**, so writes are lost on isolate recycle and
are invisible from other isolates. This keeps the reference deploy zero-provision,
but it is **not production persistence**.

The **security** stores are durable (Workers KV sessions + a Durable Object for
rate-limit / nonce); only the business-data notes store is ephemeral.

**For production**, wire a durable adapter and swap the store in `worker.ts`:

- a **D1**-backed notes store — declare a `d1` binding (with a `migrationsDir`) in
  [`smithy-deploy.config.mjs`](./smithy-deploy.config.mjs); the deploy provisions
  the database and applies migrations for you; or
- a **Durable Object**-backed store for strong per-key consistency.

Keep the `NotesStore` port contract — only replace the backing implementation.

## After the deploy

Register the callback URL at your IdP so the OIDC flow can complete:

```
https://<domain>/api/auth/callback
```

(This must match the `OIDC_REDIRECT_URI` the deploy set as a Worker var.) Then
open `https://<domain>`, click **Log in**, and you'll round-trip through your IdP
back into the SPA.
