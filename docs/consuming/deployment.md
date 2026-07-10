---
id: deployment
title: Deploying
sidebar_label: Deployment
sidebar_position: 3
---

# Deploying

A platform matrix linking the in-repo `deploy/*` references (freshly audited).
Each target wires a `DataStore` and (where there's a security pipeline) the
session/nonce/rateLimit/secrets stores from
[`security.md`](./security.md#stores-per-platform). Don't duplicate the deploy
READMEs — read them for the exact manifests; this is the map and the gotchas.

| Target | Reference | Runtime | Data store | Security stores | Serve entry |
| --- | --- | --- | --- | --- | --- |
| **Node / k8s** | `deploy/node` | Node + `@hono/node-server` | Redis (or Postgres) | Redis session/nonce; env-source secrets | `npm run start:redis` (`index.redis.ts`) |
| **Cloudflare (secured)** | `deploy/cf` | Workers (**Paid** — uses DOs) | — | KV sessions; Durable Object rate-limit + nonce; env secret | `src/worker.ts` `fetch` + `SecurityDurableObject` |
| **Cloudflare CRUD (full-stack)** | `deploy/cf-crud` | Workers (**free** plan) | Cloudflare D1 | none (all `@optionalAuth`) | `src/worker.ts` `fetch` |
| **AWS Lambda** | `deploy/aws` | Lambda + CDK + `hono/aws-lambda` | DynamoDB | one DynamoDB table backs all three; Secrets Manager | `src/handler.ts` `handle(app)` |

> **Deploying the browser app too?** See
> [frontend-deployment](./frontend-deployment.md) for the same-origin (recommended)
> vs cross-origin decision and its auth/CSRF/`SameSite` consequences — and
> `deploy/node-web`,
> the nginx same-origin front-door that pairs with the Node target below.

---

## Node / Kubernetes

Reference: `deploy/node`. Builds
`examples/todo-api` into a container served via
`index.redis.ts` (`@hono/node-server`). Internal-only `ClusterIP`.

- **Stores:** session + nonce on **Redis** (`REDIS_URL`, e.g.
  `redis://redis:6379`); secrets from the env source.
- **Env / secrets:** `REDIS_URL`; `SIGNING_KEY_<KEYID>` = **base64** HMAC bytes
  (the demo maps `demo-client → demo-v1`, so `SIGNING_KEY_DEMO_V1`).
- **No DDL** (Redis). Readiness probe = `/readyz`.
- Local run:
  ```bash
  REDIS_URL=redis://localhost:6379 \
  SIGNING_KEY_DEMO_V1=$(head -c32 /dev/urandom | base64) \
  npm run start:redis
  ```

> For a durable SQL store of record on Node, use `@smithy-hono/adapter-postgres`
> (`createPostgresDataStore` + `pgCreateTableSql`). There is no dedicated
> `deploy/` reference for Postgres — wire it as the `DataStore` and keep
> session/nonce on Redis.

## Cloudflare Workers — secured (`deploy/cf`)

Reference: `deploy/cf`. Web-standard APIs only.
**Requires the Workers Paid plan** (Durable Objects).

- **Stores:** `KvSessionStore` over KV binding `SESSIONS`;
  `DurableRateLimitStore` + `DurableNonceStore` over DO binding `SECURITY_DO`
  (class `SecurityDurableObject`); `EnvSecretProvider` over secret
  `HMAC_KEY_2026A`.
- **Secret encoding:** `HMAC_KEY_2026A` = **lowercase-hex** (CF decodes hex).
- **Setup:** `wrangler kv:namespace create SESSIONS`; the DO migration is in
  `wrangler.toml` (`new_classes = ["SecurityDurableObject"]`);
  `openssl rand -hex 32 | wrangler secret put HMAC_KEY_2026A`.
- **Env:** `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (KV + DO + Workers
  Scripts scopes). Deploy with `wrangler deploy`; local `wrangler dev`.

## Cloudflare Workers — full-stack CRUD (`deploy/cf-crud`)

Reference: `deploy/cf-crud`. Bundles
`crud-api` + the React UI into one Worker, exposes the
service as an MCP server at `/mcp`. **Free plan** (no DO/KV).

- **Data store:** Cloudflare **D1** via `createD1DataStore` (binding `DB`).
- **No security stores** (all ops `@optionalAuth`, no pipeline) → no secrets.
- **DDL:** `migrations/0001_init.sql` (output of `d1CreateTableSql('tasks')`):
  ```bash
  wrangler d1 create crud-tasks            # paste database_id into wrangler.toml
  wrangler d1 migrations apply crud-tasks  # remote
  ```
- **Env:** `CLOUDFLARE_API_TOKEN` (D1 + Workers Scripts). Binding name must stay
  `DB`. Build the UI first (`cd examples/crud-ui && npm run build`).

## AWS Lambda (`deploy/aws`)

Reference: `deploy/aws`. Provisioned by an AWS CDK
(TypeScript) app; `hono/aws-lambda` `handle()` adapts the API Gateway event
(including base64-decoding the body for raw-body HMAC).

- **Stores:** **one DynamoDB table backs all three** security stores
  (`DynamoSessionStore` / `DynamoRateLimitStore` / `DynamoNonceStore`, namespaced
  PKs `sess:` / `rl:` / `nonce:`); secrets from Secrets Manager
  (`SecretsManagerSecretProvider`).
- **Env (set by the stack):** `SECURITY_TABLE`, `SIGNING_KEY_IDS` (comma-sep,
  newest first), `SIGNING_SECRET_PREFIX` (default `prod/sig`),
  `SIGNING_CLIENT_KEY` (`<clientId>=<keyId>`), optional `ALLOWED_ORIGINS`,
  `AUDIT_SALT` (set in prod).
- **Secrets:** one Secrets Manager secret per keyId at `<prefix>/<keyId>`
  (default `prod/sig/<keyId>`), value = **base64** HMAC key.
- **No SQL DDL** — CDK provisions the table (PK `pk`, `ttl` Number with TTL
  enabled, `version` Number, `PAY_PER_REQUEST`).
- **Steps:** `cd deploy/aws && npm install && npx cdk bootstrap && npx cdk deploy`.
  `src/handler.ts` runs `validateConfig` at cold start, then `handle(app)`.
- **Caveat:** a bare Function URL is not a trusted edge — front with API
  Gateway / ALB in production.

---

## Per-platform encoding cheat-sheet

A common footgun — the signing-key encoding differs by platform:

| Platform | Secret name | Encoding |
| --- | --- | --- |
| Node | `SIGNING_KEY_<KEYID>` | base64 |
| Cloudflare | `HMAC_KEY_<...>` | lowercase-hex |
| AWS | `<prefix>/<keyId>` (Secrets Manager) | base64 |
