---
id: security
title: Securing the server
sidebar_label: Security
sidebar_position: 2
---

# Securing the server

This covers the `@smithy-hono/security-core` pipeline and how the three
authentication schemes, authorization tiers, and the production hardening knobs
fit together. The worked reference is
`examples/secure-api` (OIDC + S2S HMAC + owner
scoping); `examples/todo-api` shows the simpler
session-only and Redis variants.

- [The pipeline](#the-pipeline)
- [PipelineConfig](#pipelineconfig)
- [Stores per platform](#stores-per-platform)
- [Fail-fast: validateConfig](#fail-fast-validateconfig)
- [Health & readiness](#health--readiness)
- [Assembling the secured server](#assembling-the-secured-server)
- [AuthN: OIDC cookie sessions](#authn-oidc-cookie-sessions)
- [AuthN: service-to-service HMAC](#authn-service-to-service-hmac)
- [Operation-level authorization](#operation-level-authorization)
- [Resource-level authorization](#resource-level-authorization)
- [Rate limiting](#rate-limiting)
- [MCP as an OAuth resource server](#mcp-as-an-oauth-resource-server)
- [Production checklist](#production-checklist)

---

## The pipeline

```ts
import { createSecurityPipeline } from '@smithy-hono/security-core'

const middleware = createSecurityPipeline(OPERATIONS, config)   // MiddlewareHandler[]
app.use('*', ...middleware)
```

`createSecurityPipeline(registry, config)` returns an **array** of Hono
middleware (spread it into `app.use('*', ...)`). It reads `OPERATIONS` (from
`registry.gen.ts`) to learn each route's auth scheme, permissions, cost, and
readonly/streaming flags, then runs — in order:

> requestId → structuredLogger → errorSanitizer → securityHeaders → assertHttps →
> cors → bodyGuards → rateLimitPerIp → authenticate → verifySignature → csrf →
> rateLimitPerPrincipal → (then your router: zValidator → authorize → handler)

So origin/transport/body checks come first, then identity (`authenticate` for
sessions, `verifySignature` for S2S HMAC), then CSRF and per-principal rate
limiting. Operation-level `authorize(...)` runs inside the router; resource-level
policies run in the router's per-op middleware slots.

---

## PipelineConfig

`PipelineConfig` is an intersection of all the phase configs. The fields you'll
actually set (verified against `security-core/src/index.ts` and todo-api's
`server.ts`):

```ts
import type { PipelineConfig } from '@smithy-hono/security-core'

const config: PipelineConfig = {
  // --- SecurityConfig (base) ---
  allowedOrigins: ['https://app.example.com'],
  hsts: { maxAge: 31_536_000, includeSubDomains: true },
  idleTtlSeconds: 900,
  session: { absoluteTtlSeconds: 8 * 60 * 60, sameSite: 'Lax' /* , cookieName? */ },
  signing: { acceptanceWindowSeconds: 300 /* , replaySafeOps?, nonceForOps? */ },
  rateLimits: { perIp: { capacity: 100, refillPerSecond: 10 }, perPrincipal: { /* ... */ } },
  stores: { session, nonce, secrets, rateLimit },        // see "Stores per platform"
  logger,                                                  // { info, warn, error }
  audit,                                                   // AuditSink (optional)
  metrics,                                                 // MetricsSink (optional)
  oidc: { issuer, clientId, audience, redirectUri, authorizationEndpoint, tokenEndpoint, stateSecret },
  auditSalt: process.env.AUDIT_SALT,                      // pseudonymizes principal ids in audit

  // --- transport / validation / rate-limit / cors / csrf / signing phases ---
  forwardedProtoHeader: (c) => trustProxy ? c.req.header('x-forwarded-proto') ?? 'https' : undefined,
  clientIp: (c) => trustProxy ? c.req.header('x-forwarded-for') ?? '127.0.0.1' : 'untrusted-direct',
  maxBodyBytes: 1_048_576,
  protocolContentType: 'application/json',
  structuralLimits: { maxDepth: 32, maxArrayLength: 1000, maxObjectKeys: 256 },  // optional
  requestTimeoutMs: 15_000,
  maxInFlight: 200,
  cors: { allowedMethods: ['GET', 'POST', 'DELETE'], allowedHeaders: ['content-type'] },  // optional
  csrfHeaderName: 'X-CSRF-Token',                         // optional (this is the default)
  signingPrincipalMapper,                                 // keyId → service Principal (for @sigv4Hmac)
}
```

> **Fail closed by default.** Note how `forwardedProtoHeader` and `clientIp`
> return `undefined` / `'untrusted-direct'` unless you explicitly trust proxy
> headers (`TRUST_PROXY_HEADERS === '1'` in the examples). Only trust
> `X-Forwarded-*` when a trusted reverse proxy / load balancer sets them.

---

## Stores per platform

The pipeline needs up to four stores (in `config.stores`): `session`, `nonce`,
`rateLimit`, `secrets`. These are **separate** from the data `DataStore`. Exact
class/factory names per platform (verified against each adapter's `index.ts`):

| Store | Memory (dev) | Node/Redis (`adapter-node`) | Cloudflare (`adapter-cf`) | AWS (`adapter-aws`) |
| --- | --- | --- | --- | --- |
| session | `new MemorySessionStore()` | `new RedisSessionStore(port)` | `new KvSessionStore(kv)` | `new DynamoSessionStore(port)` |
| nonce | `new MemoryNonceStore()` | `new RedisNonceStore(port)` | `new DurableNonceStore(stub)` | `new DynamoNonceStore(port)` |
| rateLimit | `new MemoryRateLimitStore()` | `new RedisRateLimitStore(port)` | `new DurableRateLimitStore(stub)` | `new DynamoRateLimitStore(port)` |
| secrets | `new MemorySecretProvider()` | `new NodeSecretProvider(source, { currentKeyByClient })` | `new EnvSecretProvider(material, currentKeyByClient)` | `new SecretsManagerSecretProvider(source, { keyIdToSecretId, clientToCurrentKeyId })` |

Construction conventions:

- **Redis** (`adapter-node`): build a port once with `createRedisPort(client)`,
  then pass it to every store. `StoreOptions { prefix? }` lets you namespace
  (defaults `sess:` / `nonce:` / `rl:`).
  ```ts
  import Redis from 'ioredis'
  import { createRedisPort, RedisSessionStore, RedisNonceStore, NodeSecretProvider,
    envSecretSource, type RedisClientLike } from '@smithy-hono/adapter-node'

  const port = createRedisPort(new Redis(process.env.REDIS_URL!) as unknown as RedisClientLike)
  const stores = {
    session: new RedisSessionStore(port),
    nonce: new RedisNonceStore(port),
    rateLimit: new RedisRateLimitStore(port),
    secrets: new NodeSecretProvider(envSecretSource(), { currentKeyByClient: { 'demo-client': 'demo-v1' } }),
  }
  ```
  `envSecretSource()` reads `SIGNING_KEY_<KEYID>` env vars (default prefix
  `SIGNING_KEY_`); `NodeSecretProviderOptions.currentKeyByClient` is required and
  maps clientId → current keyId.
- **Cloudflare** (`adapter-cf`): `KvSessionStore` over a KV namespace;
  `DurableRateLimitStore` / `DurableNonceStore` over a Durable Object stub
  (`createFetchRateLimitStub` / `createFetchNonceStub`); `EnvSecretProvider` over
  a hex-encoded secret material map. Requires the Workers Paid plan for DOs.
- **AWS** (`adapter-aws`): build a table port with
  `createDynamoTablePort(client, tableName)` and pass it to the three stores
  (one table backs all three via namespaced PKs);
  `SecretsManagerSecretProvider` over a Secrets Manager source.

---

## Fail-fast: validateConfig

Call `validateConfig(registry, config)` **before** building the app. It throws
`ConfigValidationError` on fatal issues (e.g. a `@requiresAuth` op with no
session store, missing signing keys for `@sigv4Hmac` ops, insecure defaults), so
a misconfigured server never boots:

```ts
import { validateConfig } from '@smithy-hono/security-core'
validateConfig(OPERATIONS, config)   // throws on fatal misconfiguration
```

(`collectConfigIssues(registry, config)` returns the `ConfigIssue[]` without
throwing if you want to inspect non-fatal warnings.)

---

## Health & readiness

Mount these **before** the pipeline so orchestrator probes bypass auth:

```ts
import { healthHandler, readinessHandler } from '@smithy-hono/security-core'

app.get('/healthz', healthHandler())                 // liveness — always 200 { status: 'ok' }
app.get('/readyz', readinessHandler(config))         // readiness — probes the configured stores
```

`readinessHandler(config, opts?)` accepts `{ probes?: ReadinessProbe[],
probeStores?: boolean }` to add custom checks (e.g. a DB ping).

---

## Assembling the secured server

The canonical order is **validateConfig → health/readiness → pipeline → (auth
helper routes) → routers**. Verified against
`examples/secure-api/src/createApp.ts`:

```ts
import { Hono } from 'hono'
import {
  createSecurityPipeline, validateConfig, healthHandler, readinessHandler,
  loginHandler, callbackHandler, logoutHandler, csrfTokenHandler,
  requireResourcePolicy, isOwner, type SecurityEnv,
} from '@smithy-hono/security-core'
import { OPERATIONS } from '../generated/registry.gen'
import { createNoteRouter } from '../generated/notes.gen'

validateConfig(PIPELINE_OPERATIONS, pipelineConfig)        // (1) fail fast

const app = new Hono<SecurityEnv>()
app.get('/healthz', healthHandler())                       // (2) probes bypass the pipeline
app.get('/readyz', readinessHandler(pipelineConfig))

app.use('*', ...createSecurityPipeline(PIPELINE_OPERATIONS, pipelineConfig))   // (3) pipeline

app.get('/auth/login', loginHandler(authRoutesConfig))     // (4) OIDC helper routes
app.get('/auth/callback', callbackHandler(authRoutesConfig))
app.post('/auth/logout', logoutHandler(authRoutesConfig))
app.get('/csrf-token', csrfTokenHandler())

app.route('/', createNoteRouter(ops, { /* resource policies */ }))   // (5) routers last
```

> **`SecurityEnv`.** Type your app as `new Hono<SecurityEnv>()` so the pipeline
> can stash the authenticated `principal` on the context (`c.get('principal')`).
> The generated routers already type their handlers with `Context<SecurityEnv>`.

> **Auth-helper route registry.** secure-api adds the `/auth/*` and `/csrf-token`
> routes to a `PIPELINE_OPERATIONS = { ...OPERATIONS, ...AUTH_HELPER_OPERATIONS }`
> superset so `authenticate` knows their posture (login/callback are
> `anonymous`, logout/csrf are `oidc`). If you mount auth helper routes, do the
> same — otherwise the pipeline doesn't know how to treat them.

---

## AuthN: OIDC cookie sessions

Operations modeled with the OIDC scheme get `authSchemes: [{ type: 'oidc' }]` in
the registry; the pipeline's `authenticate` phase enforces a valid
`__Host-session` cookie. The login flow is wired with four route helpers, all
taking an `AuthRoutesConfig`:

- `loginHandler(config)` — redirects to the IdP authorization endpoint.
- `callbackHandler(config)` — verifies the ID token, mints + rotates the session
  cookie, returns a CSRF token in the body.
- `logoutHandler(config)` — clears the session.
- `csrfTokenHandler()` — returns a fresh CSRF token.

`AuthRoutesConfig` (from secure-api's `config.ts`, via `buildAuthRoutesConfig`):

```ts
{
  store: sessionStore,
  session: toAuthConfig(pipelineConfig),       // helper: derives AuthConfig from PipelineConfig
  oidc: { issuer, audience },
  clientId, clientSecret, redirectUri, authorizationEndpoint, tokenEndpoint,
  scopes: ['openid', 'profile', 'email'],
  mapPermissions,                               // (claims) => string[]  — claim → permissions
  stateSecret: oidcStateSecret,
  verifier: oidcVerifier,                        // from createOidcVerifier({ issuer, audience })
}
```

`mapPermissions: PermissionMapper` turns IdP claims (`scope` / `scp` /
`permissions`) into the principal's permission set that operation-level
`authorize` checks against. Build the verifier with `createOidcVerifier({
issuer, audience })` (from `@smithy-hono/security-core`).

Lower-level session primitives are also exported if you mint sessions yourself:
`issueSession`, `rotateSession`, `sessionFromOidcClaims`, `toAuthConfig`,
`generateToken`, `buildSessionCookie`, `DEFAULT_SESSION_COOKIE_NAME`
(`__Host-session`).

---

## AuthN: service-to-service HMAC

Operations marked `@sigv4Hmac` get `authSchemes: [{ type: 'sigv4Hmac' }]`; the
pipeline's `verifySignature` phase validates a **SH-HMAC-SHA256** signature over
the canonical request. Non-`@readonly` signed ops are nonce-tracked (replay →
401) using the `nonce` store.

Two pieces you provide:

1. **`signingPrincipalMapper`** in `PipelineConfig` — maps a verified `keyId` to
   a service `Principal`:
   ```ts
   import type { ServicePrincipalMapper } from '@smithy-hono/security-core'
   const signingPrincipalMapper: ServicePrincipalMapper =
     (keyId) => ({ id: keyId, permissions: ['notes.import'], claims: { keyId }, kind: 'service' })
   ```
2. **A secret provider** in `config.stores.secrets` that resolves keyIds to HMAC
   keys (`NodeSecretProvider` / `EnvSecretProvider` /
   `SecretsManagerSecretProvider`, see [Stores per platform](#stores-per-platform)).

On the **calling** side, sign with `signRequest` + `importHmacKey` (both exported
from `security-core`); in tests, use `harness.asService({ keyId, secret })`. Key
rotation is managed with the dev-only `key-tool` CLI (not published) and the
adapter key backends (`RedisKeyBackend` / `CfKeyBackend` / `AwsKeyBackend`).

See secure-api's `ImportNotes` operation and
`test/security-e2e.test.ts`
for the full path (sign → verify → service principal → replay rejection).

---

## Operation-level authorization

`@requiresAuth(permission: "...")` causes the router to emit an
`authorize(OPERATIONS.<Op>)` middleware that checks the principal holds the
required permission. This is generated automatically — verified against
`examples/todo-api/generated/todo.gen.ts`:

```ts
import { authorize } from '@smithy-hono/security-core'
// inside the router:
authorize(OPERATIONS.CreateTodo),   // 403 if principal lacks the permission
```

`@optionalAuth` operations (e.g. a public `ListTodos`) get **no** `authorize`
call. The permission strings are surfaced as `Permissions` in
`permissions.gen.ts`.

---

## Resource-level authorization

Operation-level `authorize` answers "may this principal call this operation?".
Resource-level policies answer "may this principal touch *this specific
record*?" — owner/tenant scoping. Drop `requireResourcePolicy(...)` into the
router's per-op middleware slot. Verified against secure-api's `createApp.ts`:

```ts
import { requireResourcePolicy, isOwner } from '@smithy-hono/security-core'

const ownerPolicy = (c: Context) => deps.notesStore.get(c.req.param('id') ?? '')

app.route('/', createNoteRouter(ops, {
  all: [ /* e.g. inject principal into AsyncLocalStorage */ ],
  GetNote:    [ requireResourcePolicy(isOwner(), { load: ownerPolicy, operation: OPERATIONS.GetNote }) ],
  DeleteNote: [ requireResourcePolicy(isOwner(), { load: ownerPolicy, operation: OPERATIONS.DeleteNote }) ],
}))
```

`requireResourcePolicy(policy, opts)`:

- `policy` — a `ResourcePolicy`. Built-ins: `isOwner(field = 'ownerId')`,
  `sameTenant(field = 'tenantId', { onMissingTenant: 'allow' | 'deny' })`
  (default `deny`), plus combinators `all(...)` / `any(...)`.
- `opts.load(c)` — loads the resource (runs **before** the router's `zValidator`,
  so read params with `c.req.param('id')`). A missing resource → **404**; a
  not-owned resource → **403**.
- `opts.operation` — the `OPERATIONS.<Op>` meta (for audit/metrics).

The `@persisted` traits `ownerField` / `tenantField` give you the same scoping
*at the data layer* automatically (auto-injected from `principal.id` /
`principal.tenantId`, scoping list/read). Use `requireResourcePolicy` when you
need it at the HTTP layer or for hand-written resources.

---

## Rate limiting

Two tiers, both in the pipeline:

- **Per-IP** (`rateLimitPerIp`) — keyed on `config.clientIp(c)`. Defaults from
  `config.rateLimits.perIp` (`TokenBucketSpec { capacity, refillPerSecond }`).
- **Per-principal** (`rateLimitPerPrincipal`) — keyed on the authenticated
  principal, after auth. Per-operation cost comes from `@cost(value)` (default 1);
  expensive ops drain the bucket faster.

Both use `config.stores.rateLimit`. Saturation can be emitted to your metrics
sink (`emitRateLimitSaturation`). Also available: `withTimeout(ms)` (from
`requestTimeoutMs`) and `loadShedder(maxInFlight)` (from `maxInFlight`) for
overload protection.

---

## MCP as an OAuth resource server

The plain `createMcpHandler({ tools, app, info })` mount (see
[`building-a-server.md`](./building-a-server.md#mcp-exposure)) is unauthenticated.
To protect it, pass `auth` and advertise the protected-resource metadata. Pattern
from `examples/todo-api/src/mcpAuth.ts`:

```ts
import { createMcpHandler, protectedResourceMetadata, getAttachedPrincipal } from '@smithy-hono/mcp-core'

const authCfg = { resource, authorizationServers, verifier }   // McpAuthConfig
const innerDispatchApp = createTodoRouter(ops, { all: [principalInjector] })
const mcpHandler = createMcpHandler({ tools: MCP_TOOLS, app: innerDispatchApp, info, auth: authCfg })

app.use('*', ...createSecurityPipeline(OPERATIONS, securityConfig))
app.route('/', createTodoRouter(ops))
app.get('/.well-known/oauth-protected-resource', () => protectedResourceMetadata(authCfg))
app.all('/mcp', (c) => mcpHandler(c.req.raw))
```

`principalInjector` reads `getAttachedPrincipal(c.req.raw)` and
`c.set('principal', p)` so the dispatched operations see the MCP caller's
identity. The production `verifier` wraps `createOidcVerifier` from
`@smithy-hono/security-core`.

---

## Production checklist

Robustness items, each backed by an export/behavior above:

- [ ] **`validateConfig` at boot** — throws before serving on fatal
      misconfiguration. Don't skip it.
- [ ] **Fail-closed proxy trust** — only trust `X-Forwarded-*` behind a trusted
      proxy; default `clientIp` / `forwardedProtoHeader` to `untrusted-direct` /
      `undefined` otherwise.
- [ ] **HTTPS enforced** — `assertHttps` is in the pipeline; set
      `hsts: { maxAge, includeSubDomains }` and a sane `forwardedProtoHeader`.
- [ ] **Body-size & structural limits** — `maxBodyBytes`, `structuralLimits`
      (`bodyGuards` rejects oversize/deeply-nested payloads).
- [ ] **Rate limits + load shedding** — `rateLimits.perIp` / `perPrincipal`,
      `@cost` weights, `requestTimeoutMs`, `maxInFlight`.
- [ ] **CSRF + CORS + security headers** — `allowedOrigins`, `cors`,
      `csrfHeaderName`; the pipeline adds CSP/referrer/frame headers via
      `securityHeaders`.
- [ ] **Sessions** — short `idleTtlSeconds` + bounded `session.absoluteTtlSeconds`,
      `__Host-` cookie, `sameSite`. Rotate on privilege change (`rotateSession`).
- [ ] **Audit & metrics sinks** — set `audit` (+ `auditSalt` to pseudonymize
      principal ids) and `metrics`; messages from non-modeled errors are never
      reflected (the `errorSanitizer` + `MODELED_ERROR_BRAND`).
- [ ] **Health/readiness** — `/healthz` (`healthHandler`) and `/readyz`
      (`readinessHandler` with store probes) mounted **before** the pipeline.
- [ ] **Secret rotation** — keep a current keyId per client
      (`currentKeyByClient` / `clientToCurrentKeyId`); rotate signing keys with
      the key backends (`RedisKeyBackend` / `CfKeyBackend` / `AwsKeyBackend`) and
      the dev `key-tool` CLI.
- [ ] **Graceful shutdown** — drain in-flight requests on `SIGTERM` (Node:
      capture the `serve(...)` server handle and `close()` it; let
      `requestTimeoutMs` bound stragglers).
