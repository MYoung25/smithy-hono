---
id: consuming-index
title: Consuming smithy-hono
sidebar_label: Overview
sidebar_position: 0
slug: /consuming/
---

# Building a production API server with smithy-hono

This is the consumer guide for **smithy-hono**: a Smithy build plugin (Maven jar)
that generates a Hono HTTP server from your Smithy model, plus a set of
`@smithy-hono/*` npm runtime packages (security pipeline, data stores, MCP
bridge, test kit) that you assemble into a real, secured, deployable server.

> For the maintainer/publishing side, see [`Publishing`](../guides/publishing.md).
> For plugin internals (authoring traits, emitter design), see
> [`Codegen plugin guide`](../authoring/codegen-plugin-guide.md) — don't read it
> to *use* the plugin, only to understand/extend it.

> **Fastest start.** `npm create @smithy-hono@latest my-app` scaffolds a
> ready-to-deploy project wired to a one-command deploy CLI (Cloudflare / Node /
> AWS) so `npm run deploy -- <domain>` puts the UI + API live same-origin — see
> [`scaffolding.md`](./scaffolding.md). This guide is the from-scratch path; the
> scaffolder wires the same pieces for you.

## The whole story, in order

1. **Install & wire** the artifacts (this file): npm packages + the codegen
   plugin jar. Templates live beside this file:
   `build.gradle.kts.example` ·
   `smithy-build.json.example`.
2. **Author your model → run codegen → consume the generated code** in a Hono
   app: [`building-a-server.md`](./building-a-server.md). Covers the Gradle
   build caveats (the `java` plugin requirement, the output-sync step,
   `outputDirectory` not being honored), choosing zero-handler `@persisted` CRUD
   vs hand-written handlers, DataStore selection per platform, errors,
   pagination, SSE, and MCP exposure.
3. **Secure it**: [`security.md`](./security.md). The
   `createSecurityPipeline` assembly, `PipelineConfig`, OIDC cookie sessions,
   service-to-service HMAC, CSRF/CORS/headers, rate limiting, resource-level
   authorization, fail-fast config validation, and the production checklist.
4. **Deploy it**: [`deployment.md`](./deployment.md). Platform matrix (Node/k8s,
   Cloudflare Workers, AWS Lambda) linking the in-repo `deploy/*` references,
   with the store wiring and secrets each needs.

## Reference apps (read these — they are the gold implementations)

| App | Shows |
| --- | --- |
| `examples/crud-api` | zero-handler `@persisted` CRUD over a `DataStore`, live MCP mount + stdio transport. No security pipeline. |
| `examples/todo-api` | hand-written operation handlers + the full security pipeline, in **memory** and **Redis** variants; MCP as an OAuth resource server. |
| `examples/secure-api` | OIDC cookie sessions, S2S HMAC import, owner-scoped resource authorization, fail-fast config validation. |

## What ships

All artifacts release in lockstep at the same version (currently **`0.2.2`** —
verified against `build.gradle.kts` and every `packages/*/package.json`).

| Artifact | Kind | Coordinate |
| --- | --- | --- |
| `@smithy-hono/security-core` | npm | [npmjs](https://www.npmjs.com/package/@smithy-hono/security-core) |
| `@smithy-hono/data-core` | npm | npmjs |
| `@smithy-hono/realtime` | npm | npmjs |
| `@smithy-hono/adapter-node` | npm | npmjs |
| `@smithy-hono/adapter-cf` | npm | npmjs |
| `@smithy-hono/adapter-aws` | npm | npmjs |
| `@smithy-hono/adapter-postgres` | npm | npmjs |
| `@smithy-hono/mcp-core` | npm | npmjs |
| `@smithy-hono/test-kit` | npm | npmjs |
| Hono codegen plugin | Maven (jar) | `com.smithy-hono:smithy-hono` — Maven Central *(with the next release)* |

The `@smithy-hono/*` packages are **public on npmjs** — `npm install` needs no
registry config, token, or auth. The adapters declare
`@smithy-hono/security-core` and `@smithy-hono/data-core` as **peer**
dependencies (`^0.2.0`), so a consumer installs each core once and the adapters
bind to it. `@smithy-hono/test-kit` is a devDependency. Also on npmjs but not
part of a typical consumer install: `@smithy-hono/key-tool` (dev CLI), the
one-command deploy CLIs `@smithy-hono/deploy-cf` / `@smithy-hono/deploy-node` /
`@smithy-hono/deploy-aws` (see [`scaffolding.md`](./scaffolding.md)), and
`@smithy-hono/client-web`.

> **Codegen plugin availability.** The Maven jar publishes to **Maven Central**
> with the next release. Until it lands there, build it from source: clone this
> repo and run `./gradlew publishToMavenLocal`, then the `mavenLocal()` repo in
> the Gradle example below resolves it.

---

## 1. npm packages (`@smithy-hono/*`)

The packages are **public on npmjs** — no `.npmrc`, registry config, or token.
Install the core(s) plus the adapter for your platform:

```bash
npm install @smithy-hono/security-core @smithy-hono/data-core @smithy-hono/adapter-node
```

The per-platform install matrix:

| Platform | Install |
| --- | --- |
| Node + Redis | `@smithy-hono/adapter-node` |
| Cloudflare Workers (D1 / KV / Durable Objects) | `@smithy-hono/adapter-cf` |
| AWS (DynamoDB + Secrets Manager) | `@smithy-hono/adapter-aws` |
| Postgres (durable data store) | `@smithy-hono/adapter-postgres` |
| MCP server bridge | `@smithy-hono/mcp-core` |
| Consumer test toolkit (dev) | `@smithy-hono/test-kit` |

`hono` and (per adapter) `ioredis` / the AWS SDK / Cloudflare types / `pg` are
**peer dependencies** — install them in the consumer. Check each package's
`peerDependencies` for exact client versions.

> **Subpath exports to know about.** `MemoryDataStore` is at
> `@smithy-hono/data-core/memory` (the main barrel exports only types + the
> error class). The MCP stdio transport is at `@smithy-hono/mcp-core/stdio`
> (Node-only). See [`building-a-server.md`](./building-a-server.md).

---

## 2. The Hono codegen plugin (Maven jar)

`com.smithy-hono:smithy-hono` is a Smithy `SmithyBuildPlugin` registered as
**`hono-codegen`**. Put the jar on the Smithy build classpath, then name the
plugin in `smithy-build.json`.

> ⚠️ **You must copy `model/traits.smithy` into your own model sources.** The
> plugin jar ships the traits only as Java `TraitService` providers — it does
> **not** bundle the trait *shape definitions* as a loadable Smithy model
> resource (there is no `META-INF/smithy` in the jar). Providers alone are not
> enough: a `use com.smithyhono#persisted` / `@persisted` in your IDL fails model
> assembly with *"Use statement refers to undefined shape"* / *"Unable to resolve
> trait"*. Copy `model/traits.smithy` from this repo
> into your model package's `model/` directory (next to your `.smithy` files) so
> the shapes resolve. Verified empirically: without the file `smithy build` fails;
> with it codegen succeeds. See
> [`building-a-server.md`](./building-a-server.md#step-1--author-your-model).

### Gradle (recommended)

> **Two things the old example got wrong, now fixed in
> `build.gradle.kts.example`:** the Smithy
> `smithy-base` plugin only creates the `smithyBuild` configuration when the
> **`java` plugin is applied**, and `mavenLocal()` should be listed first for a
> local-dev fallback. See [`building-a-server.md`](./building-a-server.md#step-2--run-codegen-gradle)
> for the complete, working build file including the output-sync task.

The essentials:

```kotlin
plugins {
    java                                                   // REQUIRED: creates the smithyBuild configuration
    id("software.amazon.smithy.gradle.smithy-base") version "1.2.0"
}

repositories {
    mavenLocal()                                           // resolves a `./gradlew publishToMavenLocal` build
    mavenCentral()                                         // the plugin publishes here with the next release
}

dependencies {
    add("smithyBuild", "com.smithy-hono:smithy-hono:0.2.2") // discoverable via ServiceLoader
}
```

### Smithy CLI / plain `smithy-build.json`

Declare the dependency directly — see `smithy-build.json.example`. Maven Central
is a default Maven repository, so once the plugin is published there no extra
config is needed (before then, `./gradlew publishToMavenLocal` puts it in `~/.m2`):

```json
{
  "version": "1.0",
  "maven": {
    "dependencies": ["com.smithy-hono:smithy-hono:0.2.2"]
  }
}
```

### Plain Maven

Once on Maven Central, no `pom.xml` `<repository>` or `settings.xml` auth is
needed — Central is a default Maven repository. Until then, `./gradlew
publishToMavenLocal` in a clone of this repo makes the jar resolvable from `~/.m2`.

### Reference the plugin

The plugin runs when named under `plugins`:

```json
{
  "version": "1.0",
  "sources": ["model"],
  "plugins": {
    "hono-codegen": {
      "service": "com.example#MyService",
      "outputDirectory": "generated",
      "packageName": "my-service-generated",
      "packageVersion": "0.1.0"
    }
  }
}
```

> **`outputDirectory` is not honored by the Smithy *Gradle* plugin.** Generated
> code always lands in `build/smithyprojections/<root>/source/hono-codegen/`
> regardless of this value. You need a copy/sync step to move it into your
> server's `src/generated`. The working `Sync`/`copy` task is in
> [`building-a-server.md`](./building-a-server.md#step-2--run-codegen-gradle).

---

## Troubleshooting

- **`use com.smithyhono#persisted` fails to resolve** (*"undefined shape"* /
  *"Unable to resolve trait"*) — most commonly you haven't copied
  `model/traits.smithy` into your model sources (the jar does not ship loadable
  trait definitions — see §2). Also confirm the plugin jar is actually on the
  Smithy build path: with Gradle the `java` plugin must be applied (otherwise the
  `smithyBuild` configuration doesn't exist and the dependency is silently
  dropped) and the dependency added with
  `add("smithyBuild", "com.smithy-hono:smithy-hono:0.2.2")`.
- **Generated code doesn't appear in `src/generated`** — `outputDirectory` is not
  honored by Gradle; you need the copy/sync task. See `building-a-server.md`.
- **Gradle can't find `com.smithy-hono:smithy-hono`** — until it's on Maven Central,
  run `./gradlew publishToMavenLocal` in a clone of this repo so `mavenLocal()`
  resolves it, and make sure `mavenLocal()` is in your `repositories {}`.
