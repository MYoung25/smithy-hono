# @smithy-hono/deploy-cf

One-command Cloudflare Workers deploy for smithy-hono apps. Point it at a bare
domain and it provisions the declared bindings (KV / Durable Objects / D1),
generates and syncs secrets, renders `wrangler.toml`, builds the UI, and deploys
— **UI + API same-origin** with the Worker owning an `/api/*` prefix and the
static assets serving everything else (SPA fallback).

```
npx smithy-hono-deploy app.example.com
```

Everything app-specific lives in a `smithy-deploy.config.{mjs,json}` you author;
the tool itself bakes in no per-app knowledge.

## What it does

Given `<domain>`, the `smithy-hono-deploy` CLI runs this ordered, **idempotent**
flow from the config directory (`process.cwd()`):

1. **Load config** — `smithy-deploy.config.mjs` (default export) or `.json`, or `--config <path>`.
2. **Resolve the API prefix** (default `/api`) and load the secrets file if any secret needs it.
3. **Preflight wrangler + account** — checks `wrangler` runs; resolves the account id from `CLOUDFLARE_ACCOUNT_ID` or `wrangler whoami`.
4. **Zone precheck** (best-effort) — if `CLOUDFLARE_API_TOKEN` is set, verifies the domain's zone is active; otherwise warns and continues.
5. **Provision bindings** — creates/reuses KV namespaces and D1 databases. Durable Objects need no pre-provisioning (the rendered `[[migrations]]` block creates them on deploy).
6. **Generate + sync secrets** — `wrangler secret put` for each declared secret (values piped over stdin).
7. **Render `wrangler.toml`** — custom-domain route, `[assets]` with `run_worker_first`, bindings, vars, observability.
8. **Build assets** — runs `assets.buildCommand` (skip with `--skip-build`).
9. **Deploy** — `wrangler deploy`.
10. **Verify + report** — probes `https://<domain><apiPrefix>/healthz`, then prints the live URL (and the OIDC redirect URI to register, if `oidc` is set).

### Idempotency & state

Provisioned resource ids and which secrets have been put are persisted to
`.smithy-deploy/<domainSlug>.json` in the config dir. Re-runs reuse existing
resources instead of recreating them. **Secret values are never logged and never
persisted** — only a per-name `provisioned` boolean. Add `.smithy-deploy/` to
`.gitignore`.

## Install

```
npm i -D @smithy-hono/deploy-cf wrangler
```

`wrangler` is an **optional peer dependency** (`>=4.20.0`) — the CLI invokes the
consumer's local install via `npx wrangler`. You must be authenticated
(`wrangler login`) or have `CLOUDFLARE_API_TOKEN` set.

## Config

Author `smithy-deploy.config.mjs` (recommended — `.json` also works for static
configs, but loses the `vars`/`oidc`-derived dynamics) exporting
`defineDeployConfig({ ... })` as the default. `defineDeployConfig` is an identity
helper that gives you editor types.

```js
import { defineDeployConfig } from '@smithy-hono/deploy-cf'

export default defineDeployConfig({
  appName: 'my-app',           // Worker name + base for resource titles
  workerEntry: 'src/worker.ts', // Worker entry, relative to the config dir

  // Static UI served same-origin. Omit for an API-only Worker.
  assets: {
    dir: 'web/dist',                 // built static-asset directory
    buildCommand: 'npm run build',   // run before deploy (in the config dir)
    apiPrefix: '/api',               // Worker owns this prefix (default /api)
    spa: true,                       // serve index.html for non-asset paths
  },

  bindings: {
    kv: [{ binding: 'SESSIONS' }],   // binding name MUST match the worker Env
    durableObjects: [
      { name: 'SECURITY_DO', className: 'SecurityDurableObject', migrationTag: 'v1' },
    ],
    d1: [{ binding: 'DB', databaseName: 'my-app-db', migrationsDir: 'migrations' }],
  },

  // Generated/synced via `wrangler secret put` on deploy.
  secrets: [
    { name: 'HMAC_KEY_2026A', generate: 'hmac-hex' },
    { name: 'OIDC_STATE_SECRET', generate: 'hmac-base64' },
    { name: 'AUDIT_SALT', generate: 'random-base64' },
    { name: 'OIDC_CLIENT_SECRET', from: 'secretsFile' },
  ],

  // Non-secret OIDC facts from YOUR IdP — surfaced into [vars] + the report.
  oidc: {
    issuer: 'https://your-tenant.example-idp.com/',
    clientId: 'your-registered-client-id',
    authorizeUrl: 'https://your-tenant.example-idp.com/authorize',
    tokenUrl: 'https://your-tenant.example-idp.com/oauth/token',
  },

  // Extra [vars], optionally derived from the resolved domain.
  vars: ({ domain }) => ({
    OIDC_REDIRECT_URI: `https://${domain}/api/auth/callback`,
    ALLOWED_ORIGINS: `https://${domain}`,
  }),

  secretsFile: 'deploy.secrets.json', // gitignored; default if omitted
})
```

### Config reference

| Field | Required | Notes |
|-------|----------|-------|
| `appName` | yes | Worker name and base for generated resource titles. |
| `workerEntry` | yes | Worker entry path, relative to the config dir. |
| `compatibilityDate` | no | Workers `compatibility_date`. Default `2024-09-23`. |
| `assets` | no | Static-UI serving. Omit for an API-only Worker. |
| `assets.dir` | yes¹ | Built static-asset directory (relative to config dir). |
| `assets.buildCommand` | no | Built before deploy; skip with `--skip-build`. |
| `assets.apiPrefix` | no | Path the Worker owns. Default `/api`. |
| `assets.spa` | no | SPA fallback to `index.html`. Default `true`. |
| `bindings.kv` | no | KV namespaces; `title` defaults to `<appName>-<binding>-<domainSlug>`. |
| `bindings.durableObjects` | no | DO classes; rendered into `[[durable_objects.bindings]]` + `[[migrations]]`. |
| `bindings.d1` | no | D1 databases; `migrationsDir` applied remotely after create (best-effort). |
| `secrets` | no | See **Secrets** below. |
| `oidc` | no | Non-secret IdP facts → `[vars]` + post-deploy report. |
| `vars` | no | `(ctx) => Record<string,string>`, merged over OIDC vars. |
| `secretsFile` | no | Path to the gitignored secrets file. Default `deploy.secrets.json`. |

¹ required only when `assets` is present.

## Secrets

Each entry in `secrets[]` is either **generated** or **read from a file**:

| Spec | Encoding | Use for |
|------|----------|---------|
| `{ name, generate: 'hmac-hex', bytes? }` | random bytes → lowercase hex | HMAC key material (what the CF `EnvSecretProvider` requires). |
| `{ name, generate: 'hmac-base64', bytes? }` | random bytes → base64 | e.g. an OIDC state-cookie signing key. |
| `{ name, generate: 'random-base64', bytes? }` | random bytes → base64 | e.g. an audit salt. |
| `{ name, from: 'secretsFile' }` | verbatim from the file | secrets you supply (e.g. an IdP client secret). |

`bytes` defaults to 32. Generated material comes from
[`@smithy-hono/key-tool`](../key-tool)'s web-standard CSPRNG; `hmac-hex` converts
the base64 it mints to hex (lossless).

For `{ from: 'secretsFile' }` secrets, create the gitignored file (default
`deploy.secrets.json`) as a JSON object keyed by secret name:

```json
{ "OIDC_CLIENT_SECRET": "..." }
```

The CLI errors clearly if a `secretsFile` secret is declared but the file or key
is missing. Rotate generated secrets with `--rotate-keys`.

## CLI

```
smithy-hono-deploy <domain> [--rotate-keys] [--skip-build] [--config <path>]
```

| Argument / flag | Meaning |
|-----------------|---------|
| `<domain>` | Bare hostname (e.g. `app.example.com`). No scheme, path, whitespace, or trailing dot. Apex or subdomain. |
| `--rotate-keys` | Force-regenerate all generated secrets (re-put them). |
| `--skip-build` | Skip the assets build step. |
| `--config <path>` | Path to the deploy config (overrides auto-discovery). |

| Env var | Effect |
|---------|--------|
| `CLOUDFLARE_ACCOUNT_ID` | Short-circuits / overrides account detection. |
| `CLOUDFLARE_API_TOKEN` | Enables the best-effort zone-active precheck. |

Progress logs go to **stderr**; the live URL (and OIDC redirect URI) go to
**stdout** — so `URL=$(smithy-hono-deploy app.example.com)` captures just the URL.

### Prerequisites

The domain must already be an **active zone** on your Cloudflare account (added in
the dashboard with the registrar's nameservers delegated to Cloudflare). The
custom-domain route then auto-provisions the DNS record and edge TLS cert. The
`/healthz` probe only **warns** if it never returns 200 — cert/DNS issuance can
lag, and the deploy may still be fine.

## Generated `wrangler.toml`

`renderWrangler` emits a `wrangler.toml` marked *DO NOT EDIT BY HAND* (re-run the
CLI to regenerate). The load-bearing parts of the same-origin full-stack layout:

- `routes = [{ pattern = "<domain>", custom_domain = true }]` — auto DNS + edge cert.
- `[assets] run_worker_first = ["<apiPrefix>/*"]` — API paths hit the Worker **before** assets; `not_found_handling = "single-page-application"` serves `index.html` for every other non-asset path.

Secrets are **never** rendered into the toml — they're bound out-of-band via
`wrangler secret put`.

## Library surface

The CLI confines all Node APIs (argv, fs, child_process, fetch) to
`src/bin/deploy.ts`; the importable surface stays pure and is usable from your
config or your own tooling:

```ts
import {
  defineDeployConfig, apiPrefixOf,   // config
  renderWrangler,                     // toml renderer (also used by the CLI)
  materializeSecret, base64ToHex,     // secret encoding
} from '@smithy-hono/deploy-cf'
```

## Reference consumer

`deploy/cf-secure/smithy-deploy.config.mjs` deploys the secure-notes reference
app — `examples/secure-api` (the seven-layer security pipeline + OIDC
cookie-session flow) and the `examples/secure-ui` SPA, same-origin. From the repo
root:

```
npm run deploy -- app.example.com
```

(which builds this package, then `cd`s into `deploy/cf-secure` and runs the CLI).

## Test

```
npx vitest run     # unit tests for wrangler rendering + secret materialization
npm run typecheck
```
