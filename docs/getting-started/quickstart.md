---
id: quickstart
title: Quickstart
sidebar_label: Quickstart
sidebar_position: 1
---

# Quickstart

A fast path from zero to a generated, running smithy-hono service. For the full
detail behind each step, follow the links into the [Consuming & building](../consuming/)
section.

## 1. Install the runtime packages

The `@smithy-hono/*` packages are **public on npmjs** — no `.npmrc`, registry
config, or token. Install the core(s) plus the adapter for your platform:

```bash
npm install @smithy-hono/security-core @smithy-hono/data-core @smithy-hono/adapter-node
```

See [Consuming → npm packages](../consuming/#1-npm-packages-smithy-hono) for the
per-platform install matrix.

## 2. Wire the codegen plugin

Put the Maven jar on the Smithy build classpath and name the `hono-codegen`
plugin in `smithy-build.json`. The jar publishes to **Maven Central** with the
next release; until then build it from source (`./gradlew publishToMavenLocal`)
and resolve it via `mavenLocal()`. **Copy `model/traits.smithy` into your model
sources** — the jar does not bundle loadable trait definitions. Full setup
(Gradle / Smithy CLI / Maven), including the output-sync caveat:
[Consuming → The Hono codegen plugin](../consuming/#2-the-hono-codegen-plugin-maven-jar).

## 3. Author your model, generate, and implement

Annotate your model with `@http` traits, run codegen, then satisfy the generated
operation interfaces in `src/routes/*.ts`. The end-to-end walkthrough — emitted
output, `@persisted` zero-handler CRUD vs hand-written handlers, DataStore
selection, errors, pagination, SSE, and MCP — is in
[Building a server](../consuming/building-a-server.md).

## 4. Secure and deploy

- **Secure it:** [Securing the server](../consuming/security.md) — the
  `createSecurityPipeline` assembly, OIDC sessions, S2S HMAC, and the production
  checklist.
- **Deploy it:** [Deploying](../consuming/deployment.md) — the platform matrix
  for Node/k8s, Cloudflare Workers, and AWS Lambda.

## Learn from the reference apps

The gold implementations live in the repo's `examples/` directory — see the
[examples reference](../reference/examples.md) for what each one demonstrates.
