---
id: scaffolding
title: Scaffolding a new app
sidebar_label: Scaffolding
sidebar_position: 5
---

# Scaffolding a new app: `npm create @smithy-hono`

The fastest on-ramp. `@smithy-hono/create` generates a ready-to-deploy project
already wired to the matching deploy CLI, so `npm run deploy -- <domain>` puts the
UI + API live **same-origin** with no hand-wiring. It's the same pieces you'd
assemble by hand in [`building-a-server.md`](./building-a-server.md) and ship per
[`deployment.md`](./deployment.md) — the scaffolder just picks the layers and
fills the tokens for you.

```bash
npm create @smithy-hono@latest my-app
```

- [What it generates](#what-it-generates-the-golden-path-layout)
- [The five prompts (and their flags)](#the-five-prompts-and-their-flags)
- [The same-origin model](#the-same-origin-model)
- [Codegen prerequisite (JVM)](#codegen-prerequisite-jvm)
- [Deploying, per target](#deploying-per-target)
- [CI/CD pipelines](#cicd-pipelines)
- [Auth flavors: none vs OIDC](#auth-flavors-none-vs-oidc)
- [Next steps](#next-steps)

---

## What it generates (the golden-path layout)

The scaffolder overlays a small stack of template layers — a shared `base`, the
backend (`app`), an optional React SPA (`ui`), and a target-specific deploy layer
— into a new project directory:

```
my-app/
  model/
    main.smithy         Smithy model — the single source of truth (edit this)
    traits.smithy       vendored smithy-hono custom traits (do not edit)
  src/
    generated/          codegen output — gitignored, run `npm run codegen` (never edit)
    createApp.ts        the DI app factory (composes the generated router)
    index.ts            local dev entry (Node, in-memory store, :3000)
    worker.ts | server.ts | handler.ts   the deploy entry (per target)
  ui/                   (full-stack only) React + Vite SPA, served same-origin
  build.gradle.kts      Smithy → TypeScript codegen wiring (`./gradlew`)
  smithy-*deploy.config.mjs   deploy config consumed by `npm run deploy`
  package.json          scripts: codegen · dev · deploy · typecheck · test
```

The backend and UI resource differ by auth flavor: the `none` flavor scaffolds an
anonymous `Task` CRUD demo; the `oidc` flavor scaffolds a `Note` resource behind
the security-core pipeline. The deploy entry filename is target-specific —
`src/worker.ts` (Cloudflare), `src/server.ts` (Node), or `src/handler.ts` (AWS).

`src/generated/` is gitignored and empty until you run codegen (see
[Codegen prerequisite](#codegen-prerequisite-jvm)).

## The five prompts (and their flags)

Run interactively on a TTY, or pass any answer as a flag (unanswered prompts are
still asked; add `--yes`/`-y` to accept defaults for everything unspecified and
skip the prompts entirely). Flags may appear in any order; the first positional
argument is the project name.

| Prompt | Flag | Values | Default | Effect |
|---|---|---|---|---|
| Project name | _(positional)_ | a valid npm package + directory name | `my-smithy-app` | Project directory + npm `name`; also seeds the Smithy service id. |
| Deploy target? | `--target` | `cloudflare` · `node` · `aws` | `cloudflare` | Installs the matching `@smithy-hono/deploy-*` CLI + adapter, deploy entry, and config. |
| Include a frontend? | `--frontend` | `fullstack` · `api-only` | `fullstack` | `fullstack` adds the `ui/` React + Vite SPA served same-origin; `api-only` ships just the HTTP API. |
| Authentication? | `--auth` | `none` · `oidc` | `none` | `none` = anonymous CRUD demo; `oidc` = security-core pipeline + OIDC cookie sessions. |
| CI/CD pipeline? | `--ci` | `github` · `gitlab` · `both` · `none` | `github` | Emits a full build+test+deploy pipeline for the chosen host(s). See [CI/CD pipelines](#cicd-pipelines). |

```bash
# Non-interactive, all defaults:
npm create @smithy-hono@latest my-app -- --yes

# Explicit: AWS, API only, OIDC, GitLab CI:
npm create @smithy-hono@latest my-api -- --target aws --frontend api-only --auth oidc --ci gitlab
```

## The same-origin model

Every target serves the built SPA and the API from **one origin**: the deploy
front-door owns an `/api/*` prefix and routes everything else to the SPA
(`index.html` fallback). Because the browser only ever talks to a single origin,
the cookie/CSRF/`SameSite` model works with no CORS.

The generated UI code hits the API through a single base URL that is empty in dev
and `/api` in the production build:

```ts
const API_BASE = import.meta.env.VITE_API_BASE ?? ''
```

- **Dev** — `npm run dev` runs the API on `:3000`; `npm --prefix ui run dev` runs
  the Vite dev server on `:5173` with a **proxy** that forwards the API routes to
  `:3000`. `VITE_API_BASE` is unset, so the SPA calls same-origin paths that Vite
  proxies through. No CORS, no second origin.
- **Production** — the deploy CLI builds the UI with `VITE_API_BASE=/api`, so the
  same code calls `/api/...`, which the front-door routes to the API while serving
  the SPA for everything else.

The `/api` prefix is the default `apiPrefix` in every deploy config; the
domain-derived OIDC redirect URI is `https://<domain>/api/auth/callback`.

The front-door is target-specific: a Cloudflare Worker that owns `/api/*` with
static assets serving the rest; an **nginx** container (the Node config's `web:`
field) that serves the SPA and reverse-proxies `/api/*` to the in-cluster API
Service; or a **CloudFront** distribution (the AWS config's `spa:` field) with an
S3 SPA origin and `/api/*` routed to the Lambda.

## Codegen prerequisite (JVM)

The generated project depends on running the Smithy → TypeScript codegen before
it will typecheck, run, or deploy:

```bash
npm run codegen   # ./gradlew syncGeneratedCode — populates src/generated/
```

This drives the Smithy Gradle build via the bundled `./gradlew`, so it **needs a
JVM on the PATH**. The output lands in `src/generated/` (gitignored). Re-run it
whenever you edit `model/main.smithy`. The Node deploy CLIs bundle `src/generated/`
into the image / Lambda, so `npm run codegen` must have run before `npm run
deploy`.

## Deploying, per target

Each target installs a config-driven, one-command deploy CLI (`npm run deploy` is
aliased to it). Point it at a bare domain:

```bash
npm run deploy -- app.example.com
```

The three CLIs share the same shape — load config → provision → sync secrets →
build the UI → deploy → verify — but each has its own config file, `define*`
helper, and prerequisites the CLI **cannot** automate.

### Cloudflare — `@smithy-hono/deploy-cf`

- **Config:** `smithy-deploy.config.mjs` via `defineDeployConfig`. Same-origin
  UI lives under the `assets:` field; the durable store is Cloudflare **D1**
  (binding `DB`).
- **What it does:** provisions the declared bindings (KV / Durable Objects / D1),
  generates + syncs secrets (`wrangler secret put`), renders `wrangler.toml` with
  a custom-domain route, builds the UI, and runs `wrangler deploy`.
- **Prerequisites:** `wrangler login` (or `CLOUDFLARE_API_TOKEN` set); the domain
  must be an **active zone** on your Cloudflare account (registrar nameservers
  delegated to Cloudflare). `wrangler` is an optional peer dependency.

### Node / Kubernetes — `@smithy-hono/deploy-node`

- **Config:** `smithy-node-deploy.config.mjs` via `defineNodeDeployConfig`. The
  same-origin nginx front-door lives under the `web:` field; the durable store is
  **Redis** (`REDIS_URL`) or an in-memory per-pod store for a single-replica demo.
- **What it does:** builds the API (and, full-stack, the nginx SPA front-door)
  container image(s), optionally pushes to a `registry`, generates + syncs secrets
  into a per-app k8s `Secret`, renders the Deployment / Service / Ingress /
  ConfigMap manifests, applies them, and probes `https://<domain>/api/healthz`.
- **Prerequisites:** a working `kubectl` context; an **Ingress controller** +
  cert-manager `ClusterIssuer` for the TLS host; a **container registry** you can
  push to (set `registry`) — or a cluster that can pull the locally-built image;
  and `npm run codegen` run first so `src/generated/` exists for the image build.

### AWS — `@smithy-hono/deploy-aws`

- **Config:** `smithy-aws-deploy.config.mjs` via `defineAwsDeployConfig`. The
  same-origin CloudFront SPA lives under the `spa:` field; the durable store is a
  **DynamoDB** table (default `<appName>-data`).
- **What it does:** drives an idempotent **CDK** deploy of a same-origin edge tier
  — CloudFront in front of a private S3 SPA origin with `/api/*` routed to a Lambda
  API origin — plus the DynamoDB DataStore table and Secrets Manager secrets;
  generates/syncs secrets and builds the UI first. (This CLI is distinct from the
  private `deploy/aws/` security-backend reference stack in this repo.)
- **Prerequisites:** AWS credentials configured (`aws configure` / SSO / env) and
  `cdk bootstrap` run once per account/region; `npm run codegen` run first (the
  Lambda bundle includes `src/generated/`); and for a custom domain, an **ACM
  certificate in `us-east-1`** (a CloudFront requirement) plus DNS you can point at
  the CloudFront distribution. `aws-cdk` is an optional peer dependency.

For the underlying manual/reference deploy wiring and the per-platform
signing-key encoding cheat-sheet, see [`deployment.md`](./deployment.md).

## CI/CD pipelines

`--ci` emits a ready-to-run pipeline that automates exactly the flow you'd run by
hand — codegen → typecheck → tests → build UI → `npm run deploy`. `github` writes
`.github/workflows/ci.yml`, `gitlab` writes `.gitlab-ci.yml`, `both` writes both,
`none` writes neither. The pipeline is keyed to your `--target` (the deploy step
differs per platform) but is otherwise agnostic to `--auth`/`--frontend`: it runs
`npm run build:ui --if-present` (a no-op for `api-only`) and only materializes the
gitignored `deploy.secrets.json` when an `OIDC_CLIENT_SECRET` is configured.

**What runs, and when.** Every push and pull/merge request runs the full build
gate (codegen on **JDK 21**, typecheck, unit tests, UI build). The deploy job runs
**only on a push to the default branch** (`main`), after a green build — PRs/MRs
build and test but never deploy.

**Keyless where the platform supports it.** The templates prefer federated OIDC
over stored long-lived keys:

| Target | Deploy auth | Configure (repo/project settings) |
|---|---|---|
| **AWS** | GitHub/GitLab **OIDC → IAM role** (keyless STS) — no stored AWS keys | `AWS_DEPLOY_ROLE_ARN`, `AWS_REGION` (one-time: an OIDC identity provider + a role trusting this repo's `main`; `cdk bootstrap` once) |
| **Cloudflare** | `CLOUDFLARE_API_TOKEN` (wrangler has no CI-OIDC path) — scope it tightly | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| **Node / k8s** | Registry push is **keyless** (`GITHUB_TOKEN` / `CI_JOB_TOKEN`); the cluster credential is a kubeconfig you provide | `KUBECONFIG_B64` (base64 kubeconfig), `IMAGE_REGISTRY` |

Common to all: set `DEPLOY_DOMAIN` (the domain passed to `npm run deploy`), and —
for the `oidc` flavor — `OIDC_CLIENT_SECRET`. Each generated CI file's header
comment lists its exact secrets/variables and the one-time setup steps. GitHub
deploys run in a `production` **environment**, giving you a deployment record and a
one-click place to add a required-reviewer approval gate later.

## Auth flavors: none vs OIDC

The `--auth` choice picks a whole flavor of the scaffold — the model resource, the
backend assembly, and the deploy config's secrets/env:

**`none`** — an anonymous `Task` CRUD demo. All operations are `@optionalAuth`, so
there is no security pipeline and no secrets to manage. Great for a first deploy.

**`oidc`** — a `Note` resource behind the full [security-core](./security.md)
pipeline with OIDC cookie sessions. The deploy config carries generated secrets
(`SIGNING_KEY_IMPORTER_V1`, `OIDC_STATE_SECRET`, `AUDIT_SALT`) and a confidential
`OIDC_CLIENT_SECRET` read from a gitignored `deploy.secrets.json`. Before your
first deploy you **must fill in your IdP facts** — they ship as honest
placeholders in the config's `env`:

- `OIDC_ISSUER` — your provider's discovery issuer (e.g. an Auth0 / Okta /
  Keycloak / Google tenant)
- `OIDC_CLIENT_ID` — your registered client id
- `OIDC_AUTHORIZE_URL` / `OIDC_TOKEN_URL` — your provider's endpoints
- `OIDC_CLIENT_SECRET` — put the confidential client secret in
  `deploy.secrets.json` (or drop it for a public PKCE client)

The redirect URI and allowed origin are derived from the deploy domain
(`OIDC_REDIRECT_URI = https://<domain>/api/auth/callback`,
`ALLOWED_ORIGINS = https://<domain>`), so register that redirect URI with your
IdP once the domain is known.

## Next steps

- **Understand the generated code** — [`building-a-server.md`](./building-a-server.md):
  the model → codegen → Hono app story, DataStore selection, errors, pagination,
  SSE, and MCP.
- **Secure it** — [`security.md`](./security.md): the pipeline the `oidc` flavor
  scaffolds.
- **Deploy details & gotchas** — [`deployment.md`](./deployment.md) and, for the
  same-origin-vs-cross-origin decision, [`frontend-deployment.md`](./frontend-deployment.md).
