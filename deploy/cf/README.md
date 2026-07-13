# Cloudflare (Workers) deployment (OPS-02)

Runnable infrastructure-as-code for the **Cloudflare** adapter
([`@smithy-hono/adapter-cf`](../../packages/adapter-cf)): a `wrangler.toml` that
provisions exactly the backends the adapter reads, plus a Worker entry that wires
those backends into the `@smithy-hono/security-core` pipeline.

Same router / ops / security posture as `examples/todo-api` — only the three
backed stores (session / rate-limit / nonce) plus the secret provider change:

| Concern | Backend | Adapter class | Binding |
| --- | --- | --- | --- |
| `SessionStore` | Workers KV | `KvSessionStore` | `SESSIONS` (KV namespace) |
| `RateLimitStore` | Durable Object (strong) | `DurableRateLimitStore` | `SECURITY_DO` |
| `NonceStore` | Durable Object (strong) | `DurableNonceStore` | `SECURITY_DO` |
| `SecretProvider` | Workers env secret | `EnvSecretProvider` | `HMAC_KEY_2026A` |

ARCH-01: the Worker entry and the adapter use **web-standard APIs only** — no
`node:*` import. The adapter never pulls in a Cloudflare SDK; the bindings on
`Env` structurally satisfy its narrow ports.

## What's here

| File | Purpose |
| --- | --- |
| `wrangler.toml` | KV namespace binding (`SESSIONS`), Durable Object binding (`SECURITY_DO` → `SecurityDurableObject`) + the `new_classes` DO migration. Placeholder ids with fill-in instructions. |
| `src/worker.ts` | Worker entry. Re-exports `SecurityDurableObject` (so wrangler can bind it) and a `fetch` handler that builds the cf adapter stores per request and mounts the security pipeline over the todo-api router/ops. |

## The schema it provisions

This matches the **live-conformance** backend the adapter is tested against
(`packages/adapter-cf/src/live.miniflare.test.ts`, run in CI via
`.github/workflows/live-conformance.yml`): a real Workers KV namespace named
`SESSIONS` and a real Durable Object bound as `SECURITY_DO` whose class delegates
to the adapter's `SecurityDurableObject` logic. The binding names and the DO
class name are identical, so what you deploy here is the same shape miniflare
exercises in CI.

## Prerequisites

- A Cloudflare account (Workers Paid plan — **Durable Objects require it**).
- `wrangler` (`npm i -g wrangler`) and `wrangler login` (or a
  `CLOUDFLARE_API_TOKEN` with Workers KV + Durable Objects + Workers Scripts
  edit scopes).
- This monorepo checked out: `src/worker.ts` imports `@smithy-hono/security-core`,
  `@smithy-hono/adapter-cf`, and the generated `examples/todo-api` router/ops.
  Build the workspace packages first (`npm run build` at the relevant packages)
  so the imports resolve; wrangler bundles the rest.

## Deploy

All commands run from `deploy/cf/`.

### 1. Account id

Set your account id in `wrangler.toml` (`account_id = "..."`) or export it:

```bash
export CLOUDFLARE_ACCOUNT_ID=$(wrangler whoami | sed -n 's/.*Account ID.*│ *\([0-9a-f]\{32\}\).*/\1/p')
```

### 2. Create the KV namespace, paste its id

```bash
wrangler kv:namespace create SESSIONS
# → copy the printed `id = "..."` into wrangler.toml's [[kv_namespaces]].id
# For local `wrangler dev`, also create + set the preview id:
wrangler kv:namespace create SESSIONS --preview
# → paste into [[kv_namespaces]].preview_id
```

The binding name **must stay `SESSIONS`** — the worker reads `env.SESSIONS`.

### 3. Durable Object migration

No manual step — the DO class and its migration are declared in `wrangler.toml`:

```toml
[[durable_objects.bindings]]
name = "SECURITY_DO"
class_name = "SecurityDurableObject"

[[migrations]]
tag = "v1"
new_classes = ["SecurityDurableObject"]
```

`wrangler deploy` applies the `v1` migration that registers the class and
provisions its per-object storage. Bump the `tag` (and use `renamed_classes` /
`deleted_classes`) only if you later rename or remove the class.

### 4. Secrets (`wrangler secret put`)

The demo client's HMAC key material is read from `env.HMAC_KEY_2026A`,
**lowercase-hex** encoded (the adapter's `EnvSecretProvider` decodes hex — see
`packages/adapter-cf/src/secrets.ts`). Never commit it; provision it out-of-band:

```bash
# generate 32 bytes of hex material and store it as the secret
openssl rand -hex 32 | wrangler secret put HMAC_KEY_2026A
```

The worker maps client `demo-client → key-2026a`, so `HMAC_KEY_2026A` is that
client's signing key. To rotate or add clients, add more `wrangler secret put`
bindings and extend the `EnvSecretProvider` material/current-key maps in
`src/worker.ts`.

> If you also serve an **OIDC** login flow, provision its config the same way
> (`wrangler secret put OIDC_CLIENT_SECRET`, etc.) and pass the values into the
> `oidc` block of the config in `src/worker.ts`. The todo-api default posture
> here uses cookie sessions + S2S HMAC only, so no OIDC secrets are required.

### 5. Deploy

```bash
wrangler deploy
```

Verify the probes (these bypass the security pipeline):

```bash
curl https://smithy-hono-security.<your-subdomain>.workers.dev/healthz   # 200 liveness
curl https://smithy-hono-security.<your-subdomain>.workers.dev/readyz    # 200 once stores respond
```

## Local dev

```bash
wrangler dev           # uses miniflare; honours the preview KV id + local DO
```

This is the same in-process Workers runtime the adapter's live-conformance suite
uses, so behaviour matches CI.

## Notes

- **KV minimum TTL is 60s.** Sub-minute idle windows are enforced in-band by the
  `KvSessionStore` read guard, not KV TTL (see the adapter README).
- **Why the DO is required.** Rate-limit and nonce need strong consistency; a DO
  is single-threaded + serial, so `consume` / `checkAndStore` is atomic. KV is
  eventually consistent and would allow overspend / replay.
- **Observability.** `createConsoleLogger()` emits one JSON line per record;
  enable Logpush to ship them off-box (the `[observability]` block turns on
  Workers logs).
