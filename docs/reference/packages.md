---
id: packages
title: Packages
sidebar_label: Packages
sidebar_position: 2
---

# Packages

The `@smithy-hono/*` runtime packages live under `packages/` in the repo. Their
READMEs double as the npm package READMEs and stay in place — this page links out
to them. (Some packages do not carry a standalone README; those link to the
package directory.)

| Package | npm scope | What it provides | Source / README |
|---|---|---|---|
| security-core | `@smithy-hono/security-core` | Pre-deserialization security pipeline: OIDC sessions, SH-HMAC S2S signing, CSRF, CORS, headers, rate limiting, two-tier authZ, audit. | packages/security-core |
| data-core | `@smithy-hono/data-core` | `DataStore<T>` persistence port + in-memory dev store + conformance suite (backs `@persisted` CRUD). | packages/data-core |
| adapter-node | `@smithy-hono/adapter-node` | Node/Redis adapter for the security-core storage interfaces. | README |
| adapter-cf | `@smithy-hono/adapter-cf` | Cloudflare (Workers KV + Durable Objects) adapter. | README |
| adapter-aws | `@smithy-hono/adapter-aws` | AWS (DynamoDB + Secrets Manager) adapter. | README |
| adapter-postgres | `@smithy-hono/adapter-postgres` | Postgres-backed `DataStore<T>` (durable store of record for Node). | README |
| mcp-core | `@smithy-hono/mcp-core` | MCP server bridge over Streamable-HTTP JSON-RPC (resources + prompts). | README |
| test-kit | `@smithy-hono/test-kit` | Consumer testing toolkit (devDependency): drive the typed client in-process. | README |
| key-tool | _(not published)_ | S2S signing-key lifecycle library + CLI. Dev/ops tool. | packages/key-tool |

For how the packages are released, see [Publishing](../guides/publishing.md).
