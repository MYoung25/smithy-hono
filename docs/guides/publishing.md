---
id: publishing
title: Publishing
sidebar_label: Publishing
sidebar_position: 1
---

# Publishing & Consuming smithy-hono

All artifacts are published to the **GitLab Package Registry** on
`https://gitlab.example.com` (project: `smithy-hono`). Ten artifacts ship in
lockstep at the same version (currently `0.1.1`):

| Artifact | Kind | Coordinate |
| --- | --- | --- |
| `@smithy-hono/security-core` | npm | GitLab npm registry |
| `@smithy-hono/data-core` | npm | GitLab npm registry |
| `@smithy-hono/adapter-cf` | npm | GitLab npm registry |
| `@smithy-hono/adapter-aws` | npm | GitLab npm registry |
| `@smithy-hono/adapter-node` | npm | GitLab npm registry |
| `@smithy-hono/adapter-postgres` | npm | GitLab npm registry |
| `@smithy-hono/mcp-core` | npm | GitLab npm registry |
| `@smithy-hono/test-kit` | npm | GitLab npm registry |
| `@smithy-hono/client-web` | npm | GitLab npm registry |
| Hono codegen plugin | Maven (jar) | `com.smithy-hono:smithy-hono:0.1.1` |

The adapters declare `@smithy-hono/security-core` and `@smithy-hono/data-core`
as **peer** dependencies pinned to `^0.1.1`, so a consumer installs each core
exactly once and the adapters bind to it. `@smithy-hono/test-kit` (consumer
testing toolkit) is a devDependency of a consumer's project; `@smithy-hono/key-tool`
is **not** published (dev-only CLI).

> **Consuming these artifacts in another project?** See the dedicated guide with
> ready-to-paste templates: [`consuming/`](../consuming/).

---

## Consuming the artifacts

Full consumer setup — npm `.npmrc`, the Gradle / Smithy-CLI / plain-Maven config
for the `hono-codegen` plugin jar, access tokens, and troubleshooting — lives in
its own guide with ready-to-paste templates:

➡️ **[`consuming/`](../consuming/)**

---

## Releasing (publishing) — maintainers

> The automated CI release job is tracked separately (OPS-07). The steps below
> are what that job runs and what a maintainer runs for a manual release.

Authentication uses GitLab's project-level endpoints. In GitLab CI,
`CI_PROJECT_ID` is set automatically and `CI_JOB_TOKEN` authenticates against the
project's own registry. The committed root `.npmrc` already references
`${CI_PROJECT_ID}` / `${NODE_AUTH_TOKEN}`.

### npm packages

```bash
export CI_PROJECT_ID=<numeric project id>     # auto in CI
export NODE_AUTH_TOKEN=<CI_JOB_TOKEN or a deploy/personal token>

# build happens via each package's `prepare` script during pack/publish.
# Order matters: security-core first, then data-core (the adapters' publish-time
# build imports its dist and declares it a peer), then the adapters, mcp-core, and
# finally test-kit (its prepare build imports security-core's dist).
npm publish -w @smithy-hono/security-core
npm -w @smithy-hono/data-core run build
npm publish -w @smithy-hono/data-core
npm publish -w @smithy-hono/adapter-cf
npm publish -w @smithy-hono/adapter-aws
npm publish -w @smithy-hono/adapter-node
npm publish -w @smithy-hono/adapter-postgres
npm publish -w @smithy-hono/mcp-core
# test-kit: its publish-time `prepare` build imports security-core's dist
# (published above) and declares it + hono as peers.
npm publish -w @smithy-hono/test-kit
# client-web (browser auth helper): zero workspace deps, so its prepare build is
# self-contained — order-independent.
npm publish -w @smithy-hono/client-web
```

Verify a tarball before publishing with `npm pack -w <pkg> --pack-destination /tmp`.

### Maven jar (codegen plugin)

```bash
export CI_PROJECT_ID=<numeric project id>     # auto in CI
# In CI: CI_JOB_TOKEN is picked up automatically (Job-Token header).
# Locally: export GITLAB_TOKEN=<personal/deploy token> (Private-Token header).
./gradlew publishMavenPublicationToGitLabRepository
```

### Cutting a new version

Bump all artifacts together (the npm `version` field in every published
`packages/*/package.json` and `version` in `build.gradle.kts`), keep the
adapter→core peer range compatible, then tag `vX.Y.Z` (the tag version must match
the package version — the CI `publish` job enforces this by comparing the tag to
`security-core`'s version) and let CI publish. The `publish` job
`needs: [unit-tests, adapter-tests, type-check, test-kit, node-smoke]`, so the
unit/adapter/type-check/test-kit suites **and** the ephemeral k8s smoke (which
itself needs the image build) must all pass before anything is published. Note the
`vX.Y.Z` tag must be a **protected** tag, since the smoke's `SMOKE_KUBE_TOKEN` is a
masked + protected variable.
