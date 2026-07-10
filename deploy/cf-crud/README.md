# Cloudflare (Workers) deployment — full-stack CRUD demo

Runnable infrastructure-as-code that deploys the **zero-handler CRUD demo**
([`examples/crud-api`](../../examples/crud-api)) plus its **React UI**
([`examples/crud-ui`](../../examples/crud-ui)) to Cloudflare Workers as a single
full-stack Worker:

- the generated `Task` router, backed by a **D1** `DataStore`
  (`@smithy-hono/adapter-cf`'s `createD1DataStore`) — the *same* generated
  `createDefaultTaskOperations` factory the Node entry uses, just with a durable
  D1 store instead of the in-memory one;
- the same service exposed as an **MCP server** at `/mcp` (Plan 14) — the
  `createCrudApp` factory mounts the `@smithy-hono/mcp-core` bridge, so every
  generated operation is also an MCP tool with no extra Worker wiring;
- the built UI served as **static assets** by the platform, so the browser hits
  `/tasks` same-origin (no CORS) — the production equivalent of the Vite dev
  proxy in `examples/crud-ui/vite.config.ts`.

| Concern | Backend | Adapter | Binding |
| --- | --- | --- | --- |
| `DataStore<TaskData>` | Cloudflare D1 (SQL) | `createD1DataStore` | `DB` (D1 database) |
| Static UI (`crud-ui/dist`) | Workers Static Assets | — (platform) | `[assets]` |

> **Free plan.** Unlike [`deploy/cf`](../cf) (the security backend, which needs
> Workers Paid for Durable Objects), this demo uses **no Durable Objects and no
> KV** — just D1 and static assets — so it runs on the Cloudflare **free** plan.
> The CRUD ops are all `@optionalAuth`, so there is no security pipeline.

ARCH-01: web-standard APIs only. The real `D1Database` binding structurally
satisfies the adapter's narrow `D1DatabaseLike` port — no `@cloudflare/workers-types`
or Cloudflare SDK import.

## What's here

| File | Purpose |
| --- | --- |
| `wrangler.toml` | D1 binding (`DB` → `crud-tasks`) + `[assets]` pointing at the built UI + `migrations_dir`. Placeholder `database_id` with fill-in instructions. |
| `src/worker.ts` | Worker entry: builds a D1-backed `DataStore` and hands it to `createCrudApp`, the example's app factory, which wires it through the generated `createDefaultTaskOperations` and mounts the generated `Task` router **and** the MCP server at `/mcp`. |
| `migrations/0001_init.sql` | The DataStore schema (output of the adapter's `d1CreateTableSql('tasks')`). |

## Prerequisites

- A Cloudflare account (the **free** plan is sufficient).
- `wrangler` (`npm i -g wrangler`) and `wrangler login` (or a
  `CLOUDFLARE_API_TOKEN` with D1 + Workers Scripts edit scopes).
- This monorepo checked out, with the workspace packages built so the imports
  resolve (`npm run build` builds `@smithy-hono/security-core`; the adapters'
  dist is built by their `prepare`/the Gradle pack step). The UI must be built
  (next step); wrangler bundles the rest.

## Build the UI

`[assets].directory` points at `examples/crud-ui/dist`, which is a build artifact
(gitignored). Build it first:

```bash
cd ../../examples/crud-ui && npm install && npm run build   # emits dist/
```

## Deploy

All commands run from `deploy/cf-crud/`.

### 1. Create the D1 database, paste its id

```bash
wrangler d1 create crud-tasks
# → copy the printed `database_id = "..."` into wrangler.toml's [[d1_databases]].database_id
```

The binding name **must stay `DB`** — the worker reads `env.DB`.

### 2. Apply the schema migration

```bash
wrangler d1 migrations apply crud-tasks            # remote D1
```

### 3. Deploy

```bash
wrangler deploy
```

Then open the printed `https://smithy-hono-crud.<subdomain>.workers.dev/` — the UI
loads and talks to `/tasks` same-origin. Smoke the API directly:

```bash
B=https://smithy-hono-crud.<subdomain>.workers.dev
curl -X POST $B/tasks -H 'content-type: application/json' -d '{"title":"hello"}'   # 201 { item }
curl $B/tasks                                                                       # 200 { items }
# MCP: list the tools (one per generated operation)
curl -X POST $B/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'                              # { result: { tools: [...] } }
```

## Local dev (miniflare — no account needed)

```bash
# from deploy/cf-crud/, after building the UI (above):
wrangler d1 execute crud-tasks --local --file=migrations/0001_init.sql   # seed the local D1 schema
wrangler dev --local                                                     # serves UI + API on :8787
```

This is the same in-process Workers runtime the adapter's live-conformance suite
uses, so behaviour matches CI. The local D1 sqlite + caches live under
`.wrangler/` (gitignored).

## Notes

- **D1 is the durable store.** The worker constructs a fresh `DataStore` per
  request; persistence across requests comes entirely from D1 (an in-memory store
  would lose data between requests / isolates — which is why the Node entry's
  memory store is dev-only).
- **Hard delete by default.** The `Task` resource is a bare `@persisted` (no
  `softDelete`), so `DELETE /tasks/{id}` physically removes the row; a subsequent
  `GET` is `404 TaskNotFound`.
- **Asset routing.** With a `main` Worker and `[assets]`, the platform serves a
  matching static asset first and falls through to the Worker on a miss, so `/`
  and `/assets/*` are the UI and `/tasks*` reaches the router.
