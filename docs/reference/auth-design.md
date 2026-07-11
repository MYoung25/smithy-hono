---
id: auth-design
title: Auth & AuthZ design
sidebar_label: Auth design
sidebar_position: 1
---

# Auth/AuthZ Strategy for smithy-hono

> **Status (as-built).** An early proposal — a thin `@smithy-hono/auth` package
> hanging off a generated `authMiddleware` stub (`createJwtAuth` /
> `createMongoAuth` / `createApiKeyAuth`) — was **NOT** the path taken and has
> been removed from this document. Auth/authZ now ships as a full, first-party
> security pipeline in **`@smithy-hono/security-core`**, not as a pluggable
> JWT/Mongo middleware factory. The generated `authMiddleware` stub the proposal
> depended on was **retired** (the route emitter no longer emits it; see
> `src/test/java/com/smithyhono/RouteEmitterTest.java`). The current design is
> documented below.

---

## Current Implementation (as-built)

Authentication and authorization are implemented in `@smithy-hono/security-core`
(`packages/security-core/src/**`), Web-standard APIs only (ARCH-01: no `node:*`,
no `Buffer`, no module-level env reads — config is injected, ARCH-05).

### The pipeline

`createSecurityPipeline(OPERATIONS, config)` (`pipeline/index.ts`) composes the
canonical pre-deserialization middleware stack, mounted app-wide
(`app.use('*', ...createSecurityPipeline(...))`). The twelve ordered slots,
outermost → innermost:

1. `requestId` (S9)
2. `structuredLogger` (S9)
3. `errorSanitizer` (S9)
4. `securityHeaders` (S3)
5. `assertHttps` (S3)
6. `cors` (S8) — OPTIONS preflight short-circuits here
7. `bodyGuards` (S4)
8. `rateLimitPerIp` (S7)
9. `authenticate` (S5) — sets `c.get('principal')`
10. `verifySignature` (S6) — S2S (`sigv4Hmac`) ops only
11. `csrf` (S8) — cookie-auth requests only
12. `rateLimitPerPrincipal` (S7)

Optional OPS-04 DoS guards (`loadShedder` / `withTimeout`) mount between slot 6
and slot 7 when configured. The per-request operation is matched from the
codegen-emitted `OPERATIONS` registry (`registry.gen.ts`) via `resolveOp` — core
reads it structurally and never imports generated code.

### Authentication (S5)

- **OIDC cookie sessions** — the browser flow. `auth/oidc.ts` does OIDC
  discovery, caches a remote JWKS, and verifies an ID token's signature + `iss` /
  `aud` / `exp` / `iat` / `nonce` via `jose` (Web-Crypto). Verification returns a
  **branded** `VerifiedClaims` type that only `sessionFromOidcClaims` accepts — a
  compile-time auth-bypass guard (RT-03). `jose` is the only `jose`-importing
  module and is tree-shakeable, so non-OIDC deploys never load it.
- **Server-authoritative sessions** — the browser holds only an opaque id in a
  `__Host-` cookie; the principal, the CSRF synchronizer token, and the
  absolute-expiry ceiling live in the `SessionStore`. `auth/session.ts` mints,
  **rotates** (rotate-on-privilege-change, AUTH-04), and derives those records;
  the `authenticate` phase slides the idle TTL (AUTH-05) and sets both
  `principal` and `session` on the context.
- The `authenticate` phase runs **before** body parsing (AUTH-11) and emits a
  uniform 401 on any failure (AUTH-10). S2S ops are deferred to S6.

### Service-to-service signing (S6)

A custom **SH-HMAC-SHA256** scheme (the `@sigv4Hmac` trait / `sigv4Hmac` auth
scheme). `signing/signer.ts` is a portable, Hono-free reference signer; the
`verifySignature` phase (`signing/verifySignature.ts`) re-derives the body hash
from the raw bytes (`signing/rawBody.ts`) and verifies against the **same**
canonicalization (`signing/canonical.ts`) — a round-trip proven in
`signing/roundtrip.test.ts`. Crypto is `crypto.subtle` HMAC only. Signing keys are
provisioned/rotated/revoked (with an overlap window) by `@smithy-hono/key-tool`.

### Authorization (two-tier)

- **Operation tier** — `pipeline/authorize.ts`. `authorize(OPERATIONS.<Op>)` is
  the codegen-emitted post-validation hook on every protected route; it enforces
  the operation's `requiredPermissions` deny-by-default (401 no principal / 403
  `AccessDenied` missing permission, AUTHZ-01/02).
- **Resource tier** — `authz/resourcePolicy.ts`. `requireResourcePolicy(...)`
  rides the per-operation middleware slot (NO codegen, AUTHZ-09) and answers "may
  this principal act on *this* resource?" with zero-dep ABAC helpers (`isOwner`,
  `sameTenant`, `all`, `any`) plus a memoizing loader so the resource is fetched
  at most once (AUTHZ-03). The same interface accepts a ReBAC engine (OpenFGA /
  Cedar). Owner/tenant scoping is also expressed declaratively on `@persisted`
  resources via the `ownerField` / `tenantField` trait members (AUTHZ-07).

### CSRF, CORS, headers, rate limiting

- **CSRF** (`pipeline/csrf.ts`) — server-authoritative synchronizer-token check
  for cookie-authenticated state-changing requests; `!session` is the
  registry-free signal that a request is not cookie-authed and is skipped.
- **CORS** (`pipeline/cors.ts`) — config-injected origin allow-list with the
  preflight short-circuit and credentialed-CORS discipline; implemented directly
  rather than wrapping Hono's `cors` so the allow-list is injected.
- **Security headers** (`pipeline/headers.ts`) — response headers + HTTPS
  assertion, route-class aware (`@sseStream` ops skip `Cache-Control: no-store`).
- **Rate limiting** (`pipeline/rateLimit.ts`) — two token-bucket limiters
  (per-IP pre-auth, per-principal post-auth) honoring each operation's `@cost`,
  plus `authRateLimit` (brute-force), `withTimeout`, and `loadShedder`. Backed by
  strongly-consistent store adapters (Redis Lua / DynamoDB CAS / Workers-KV).

### Storage & adapters

Four injected storage interfaces — `SessionStore`, `RateLimitStore`,
`NonceStore`, `SecretProvider` (`storage/index.ts`, in-memory dev impls in
`storage/memory.ts`, conformance suite in `storage/conformance.ts`) — are
implemented by `@smithy-hono/adapter-node` (Redis), `@smithy-hono/adapter-aws`
(DynamoDB + Secrets Manager), and `@smithy-hono/adapter-cf` (Workers KV +
Durable Objects). `examples/secure-api` is the end-to-end wired reference.

### Auth-related Smithy traits

Defined in `model/traits.smithy` (Java in `src/main/java/com/smithyhono/traits/`):

- `@requiresAuth(permission?)` — operation requires authentication; the optional
  permission is checked against the principal (`RequiresAuthTrait`).
- `@sigv4Hmac` — marks an operation as requiring SH-HMAC S2S signing; surfaces as
  the `sigv4Hmac` auth scheme (`Sigv4HmacTrait`).
- `@cost(value)` — relative operation cost for the rate limiter (`CostTrait`).

(`@persisted` also carries the `ownerField` / `tenantField` scoping knobs used by
resource-tier authZ.)
