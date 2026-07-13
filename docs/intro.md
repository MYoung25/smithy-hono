---
id: intro
title: Introduction
sidebar_label: Introduction
sidebar_position: 1
slug: /
---

# smithy-hono

A Smithy build plugin that generates Hono routes, Zod validation schemas, typed
error classes, and SSE event types from a Smithy model — plus a set of
runtime-agnostic npm packages (security pipeline, persistence/DataStore,
deployment adapters, MCP bridge) that the generated code wires into.

## What it does

Given a Smithy model annotated with `@http` traits, the codegen plugin emits:

- **`generated/*.gen.ts`** per resource — Zod schemas, typed error classes, an
  operation handler interface, and a `createXyzRouter(ops, middleware?)` factory.
- **`generated/events.gen.ts`** — a discriminated union of all `@sseEvent`
  shapes, a `<Service>EventEmitter` interface, and a typed event-source client.
- **`generated/registry.gen.ts`** — the `OPERATIONS` metadata map (auth schemes,
  permissions, cost, sensitive fields, streaming) the security pipeline reads.
- **a typed client** and, for `@persisted` resources, **zero-handler DB-backed
  CRUD**.

Your implementation files (`src/routes/*.ts`) satisfy the generated interfaces —
they are never overwritten.

## The package set

The codegen output runs against a set of runtime-agnostic `@smithy-hono/*` npm
packages (Web-standard APIs only — Workers / Lambda / Node):

| Package | What it provides |
|---|---|
| `@smithy-hono/security-core` | Pre-deserialization security pipeline: OIDC cookie sessions, SH-HMAC S2S signing, CSRF, CORS, security headers, rate limiting, two-tier authorization, audit. |
| `@smithy-hono/data-core` | The `DataStore<T>` persistence port + in-memory dev store + conformance suite — backs `@persisted` CRUD. |
| `@smithy-hono/adapter-node` | Node/Redis adapter for the security-core storage interfaces. |
| `@smithy-hono/adapter-cf` | Cloudflare (Workers KV + Durable Objects) adapter. |
| `@smithy-hono/adapter-aws` | AWS (DynamoDB + Secrets Manager) adapter. |
| `@smithy-hono/adapter-postgres` | Postgres-backed `DataStore<T>` (durable store of record for Node). |
| `@smithy-hono/mcp-core` | Bridge exposing a generated service as an MCP server over Streamable-HTTP JSON-RPC (resources + prompts). |
| `@smithy-hono/test-kit` | Consumer testing toolkit (devDependency): drive the generated typed client against your pipeline in-process. |

`@smithy-hono/key-tool` (S2S signing-key lifecycle library + CLI) ships in the
repo but is **not published** — it is a dev/ops tool.

## How it fits together

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

## Where to go next

- **New here?** Start with the [Getting started](./getting-started/) quickstart.
- **Building a service?** The [Consuming & building](./consuming/) section is the
  end-to-end guide: install & wire the artifacts, author your model, consume the
  generated code, secure it, and deploy it.
- **Securing it?** [Security](./consuming/security.md) covers the pipeline,
  config, OIDC sessions, S2S HMAC, and the production checklist.
- **Deploying it?** [Deployment](./consuming/deployment.md) is the platform matrix
  (Node/k8s, Cloudflare Workers, AWS Lambda).
- **Extending the plugin?** The [Codegen plugin guide](./authoring/codegen-plugin-guide.md)
  documents the emitter design and trait authoring.
- **Operating it?** The [Operational guides](./guides/) cover publishing, testing,
  key lifecycle, and CI pipeline testing.
- **Looking something up?** The [Reference](./reference/) section has the auth
  design and curated indexes of the in-repo packages, deploy targets, and
  examples.
