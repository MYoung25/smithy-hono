# smithy-hono

A Smithy build plugin that generates Hono routes, Zod validation schemas, typed
error classes, and SSE event types from a Smithy model — plus a set of
runtime-agnostic npm packages (security pipeline, persistence/DataStore,
deployment adapters, MCP bridge) that the generated code wires into.

## Documentation

The full documentation is a [Docusaurus](https://docusaurus.io/) site sourced
from the [`docs/`](./docs) directory and built from [`website/`](./website)
(`cd website && npm install && npm run build`), published to Cloudflare Pages. The
`docs/` tree is the single source of truth — `website/` only renders it.

Key docs (links go to their locations under `docs/`):

| Doc | Path |
|---|---|
| Getting started (quickstart) | [docs/getting-started/quickstart.md](./docs/getting-started/quickstart.md) |
| Scaffold a new app (`npm create @smithy-hono`) | [docs/consuming/scaffolding.md](./docs/consuming/scaffolding.md) |
| Consuming & building a server | [docs/consuming/](./docs/consuming) · [building-a-server.md](./docs/consuming/building-a-server.md) |
| Security | [docs/consuming/security.md](./docs/consuming/security.md) |
| Deployment | [docs/consuming/deployment.md](./docs/consuming/deployment.md) |
| Frontend deployment | [docs/consuming/frontend-deployment.md](./docs/consuming/frontend-deployment.md) |
| Codegen authoring guide | [docs/authoring/codegen-plugin-guide.md](./docs/authoring/codegen-plugin-guide.md) |
| Auth & authZ design | [docs/reference/auth-design.md](./docs/reference/auth-design.md) |
| Operational guides (publishing / testing / key lifecycle / pipeline) | [docs/guides/](./docs/guides) |
| Package, deploy & example READMEs | [packages/](./packages) · [deploy/](./deploy) · [examples/](./examples) |

## What it does

Given a Smithy model annotated with `@http` traits, the codegen plugin emits:

- **`generated/*.gen.ts`** per resource — Zod schemas, typed error classes, operation handler interface, and a `createXyzRouter(ops, middleware?)` factory
- **`generated/events.gen.ts`** — discriminated union of all `@sseEvent` shapes, a `<Service>EventEmitter` interface, and a `<Service>EventSource` typed client wrapper
- **`generated/registry.gen.ts`** — the `OPERATIONS` metadata map (auth schemes, permissions, cost, sensitive fields, streaming) the security pipeline reads
- **a typed client** and, for `@persisted` resources, **zero-handler DB-backed CRUD**

Your implementation files (`src/routes/*.ts`) satisfy the generated interfaces. They are never overwritten.

## Scaffold a new app

The fastest way to start is the scaffolder — it generates a ready-to-deploy
project wired to the matching deploy CLI, so a single command puts the UI + API
live same-origin:

```bash
npm create @smithy-hono@latest my-app
```

It prompts for a deploy target (Cloudflare / Node / AWS), full-stack SPA vs
API-only, auth (none / OIDC), and a CI/CD pipeline (GitHub Actions / GitLab CI /
both / none) — or skip the prompts with `--target`, `--frontend`, `--auth`,
`--ci`, and `--yes`. Then:

```bash
cd my-app
npm install
npm run codegen                   # Smithy → src/generated (needs a JVM: ./gradlew)
npm run dev                       # local API on :3000
npm run deploy -- <your-domain>   # build + provision + deploy, UI + API same-origin
```

See [docs/consuming/scaffolding.md](./docs/consuming/scaffolding.md) for the
generated layout, the five prompts, the same-origin model, the CI/CD pipelines,
and the per-target prerequisites.

## Runtime packages

The codegen output runs against a set of runtime-agnostic npm packages (Web-standard
APIs only — Workers / Lambda / Node). All are published to npm in lockstep with the
Maven codegen jar; see [docs/guides/publishing.md](./docs/guides/publishing.md).

| Package | What it provides |
|---|---|
| `@smithy-hono/security-core` | The pre-deserialization security pipeline: OIDC cookie sessions, SH-HMAC (`sigv4Hmac`) S2S signing, CSRF, CORS, security headers, rate limiting, two-tier authorization, audit. |
| `@smithy-hono/data-core` | The `DataStore<T>` persistence port + in-memory dev store + conformance suite — backs `@persisted` CRUD. |
| `@smithy-hono/adapter-node` | Node/Redis adapter for the security-core storage interfaces. |
| `@smithy-hono/adapter-cf` | Cloudflare (Workers KV + Durable Objects) adapter. |
| `@smithy-hono/adapter-aws` | AWS (DynamoDB + Secrets Manager) adapter. |
| `@smithy-hono/adapter-postgres` | Postgres-backed `DataStore<T>` (durable store of record for the Node deployment). |
| `@smithy-hono/mcp-core` | Bridge that exposes a generated service as an MCP (Model Context Protocol) server over Streamable-HTTP JSON-RPC, including MCP resources and prompts. |
| `@smithy-hono/test-kit` | Consumer testing toolkit (devDependency): drive the generated typed client against your pipeline in-process, with auth/HMAC helpers and an in-memory MCP client. |
| `@smithy-hono/client-web` | Browser auth helper: drives the OIDC cookie-session flow (login/callback/CSRF/logout) and wires it into the generated client (`credentials`, CSRF header, rotation-retry). Web-standard, zero deps. |

`@smithy-hono/key-tool` (S2S signing-key lifecycle library + CLI) ships in this
repo but is **not published** — it is a dev/ops tool.

## Scaffolding & deployment CLIs

Node-only tooling (not part of the runtime) that scaffolds a project and takes it
from a domain to a live UI + API same-origin under an `/api/*` prefix. All public
on npm; see [docs/consuming/scaffolding.md](./docs/consuming/scaffolding.md).

| Package | What it provides |
|---|---|
| `@smithy-hono/create` | The `npm create @smithy-hono` scaffolder: prompts for deploy target (Cloudflare / Node / AWS), full-stack-vs-API-only, auth (none / OIDC), and CI/CD (GitHub Actions / GitLab CI), then generates a ready-to-deploy project wired to the matching `@smithy-hono/deploy-*` CLI. |
| `@smithy-hono/deploy-cf` | One-command Cloudflare Workers deploy: provisions bindings (KV / Durable Objects / D1), syncs secrets, renders `wrangler.toml`, builds the UI, deploys. Config: `smithy-deploy.config.mjs` (`assets:`). |
| `@smithy-hono/deploy-node` | One-command Node/Docker/Kubernetes deploy: builds the API (and optional nginx SPA front-door) image, syncs secrets into a k8s Secret, renders the Deployment/Service/Ingress/ConfigMap, applies them. Config: `smithy-node-deploy.config.mjs` (`web:`). |
| `@smithy-hono/deploy-aws` | One-command AWS deploy (CDK): CloudFront + S3 SPA origin + `/api/*` Lambda origin + DynamoDB DataStore + Secrets Manager. Config: `smithy-aws-deploy.config.mjs` (`spa:`). |

## How it fits into the stack

```
model/*.smithy
  │
  ▼ ./gradlew smithyBuild
generated/*.gen.ts   (never edit)
  │
  ▼ implement the interfaces
src/routes/*.ts      (you own these)
  │
  ▼ tsup
dist/                (deployable bundle)
```

## Examples

- [`examples/todo-api`](./examples/todo-api) — minimal codegen demo (model → generated routes → dev pipeline). See its [README](./examples/todo-api/README.md).
- [`examples/secure-api`](./examples/secure-api) — **fully-wired secure-service reference** (OPS-08): OIDC cookie sessions, S2S HMAC signing, resource policies, CSRF, audit, and fail-fast config validation over the real Redis adapter. See its [README](./examples/secure-api/README.md) for the end-to-end wiring guide.
- [`examples/crud-api`](./examples/crud-api) — `@persisted` zero-handler CRUD demo (DB-backed lifecycle ops with no hand-written handlers) plus the MCP server bridge (`mcp:stdio`).
- [`examples/crud-ui`](./examples/crud-ui) — a Vite browser front-end that drives the generated typed client against `crud-api`.

## Implementation plan

The `plan/` directory contains the full development plan, one file per phase:

| File | Topic |
|---|---|
| [plan/00-overview.md](./plan/00-overview.md) | Architecture, plugin approach decision, data flow |
| [plan/01-plugin-bootstrap.md](./plan/01-plugin-bootstrap.md) | Gradle setup, `SmithyBuildPlugin` wiring |
| [plan/02-shape-resolver.md](./plan/02-shape-resolver.md) | Smithy AST traversal, `ModelIndex` |
| [plan/03-zod-emitter.md](./plan/03-zod-emitter.md) | Shape → Zod schema generation |
| [plan/04-route-emitter.md](./plan/04-route-emitter.md) | HTTP traits → Hono router factory |
| [plan/05-error-discrimination.md](./plan/05-error-discrimination.md) | `@error` shapes → restJson1-compatible error classes |
| [plan/06-http-bindings.md](./plan/06-http-bindings.md) | `@httpLabel`/`@httpQuery`/`@httpHeader`/`@httpPayload` |
| [plan/07-custom-traits.md](./plan/07-custom-traits.md) | `@requiresAuth` trait → auth middleware injection |
| [plan/08-edge-cases.md](./plan/08-edge-cases.md) | Recursive shapes, mixins, enums, sparse collections |
| [plan/09-sse-codegen.md](./plan/09-sse-codegen.md) | `@sseEvent` → event union + emitter + client wrapper |
| [plan/10-testing.md](./plan/10-testing.md) | Snapshot tests, tsc type-check, CI |
| [plan/11-phases.md](./plan/11-phases.md) | Week-by-week timeline, milestones |
| [plan/12-extensible-middleware.md](./plan/12-extensible-middleware.md) | Per-operation middleware slot, resource-policy tier |
| [plan/13-default-crud-persistence.md](./plan/13-default-crud-persistence.md) | `@persisted` zero-handler CRUD + `DataStore<T>` |
| [plan/14-mcp-server.md](./plan/14-mcp-server.md) | MCP server bridge (tools, resources, prompts) |
| [plan/security/](./plan/security) | Security pipeline design (S3–S9, signing, authZ) |

Start with [plan/00-overview.md](./plan/00-overview.md).
