# secure-api — the fully-wired secure-service reference (OPS-08)

A reference service that engages **every** security layer the `@smithy-hono`
runtime offers, in front of REAL generated routes, against a REAL adapter
(`@smithy-hono/adapter-node` over Redis). Where [`../todo-api`](../todo-api) is the
minimal codegen demo, this is the *"how do I wire up a secure service end to end"*
guide: OIDC cookie sessions, S2S HMAC signing, resource policies, CSRF, audit, and
fail-fast config validation, all composed from the published packages.

> The generated code under `generated/` is produced by the `hono-codegen` Smithy
> plugin from [`model/main.smithy`](./model/main.smithy) — the same plugin
> `todo-api` uses (`smithy-build.json`) — and is checked in so the example builds
> standalone. The resource-policy tier is **not** codegen'd (AUTHZ-09): it is wired
> by hand into the generated per-operation middleware slots in
> [`src/createApp.ts`](./src/createApp.ts).

---

## The model

[`model/main.smithy`](./model/main.smithy) defines a tiny "notes" service whose
operations deliberately cover each auth posture:

| Operation | Method + path | Auth scheme | Guards engaged |
| --- | --- | --- | --- |
| `CreateNote` | `POST /notes` | OIDC cookie | authorize(`notes.write`) + **CSRF** |
| `GetNote` | `GET /notes/:id` | OIDC cookie | authorize(`notes.read`) + **`isOwner` resource policy** |
| `DeleteNote` | `DELETE /notes/:id` | OIDC cookie | authorize(`notes.write`) + **CSRF** + **`isOwner`** |
| `ListNotes` | `GET /notes` | OIDC cookie | authorize(`notes.read`) |
| `ImportNotes` | `POST /s2s/import` | **`@sigv4Hmac` (S2S)** | signature verify + replay (nonce) + authorize(`notes.import`) |

Plus the OIDC auth-helper routes wired in `createApp.ts`: `GET /auth/login`,
`GET /auth/callback`, `POST /auth/logout`, `GET /csrf-token`, and the probes
`GET /healthz` / `GET /readyz`.

---

## How each security layer is engaged

All wiring lives in [`src/config.ts`](./src/config.ts) (the two injected config
objects) and [`src/createApp.ts`](./src/createApp.ts) (the composition). The config
**keys** below are the exact fields you set.

1. **OIDC login / callback / logout / `/csrf-token`** (RT-04, RT-03, RT-05).
   `loginHandler` / `callbackHandler` / `logoutHandler` / `csrfTokenHandler` from
   `security-core` are mounted in `createApp.ts`. They read an `AuthRoutesConfig`
   (`buildAuthRoutesConfig`) built from the canonical `oidc.*` fields
   (`issuer`, `clientId`, `redirectUri`, `authorizationEndpoint`, `tokenEndpoint`)
   plus `oidcStateSecret` (HMAC for the login↔callback transaction cookie) and the
   injected `verifier`. The callback **verifies** the ID token (`createOidcVerifier`),
   **mints** a session from the validated claims (`sessionFromOidcClaims` → RT-03),
   **rotates** any pre-auth session id (RT-05), sets the `__Host-session` cookie, and
   returns the CSRF token in the body.

2. **Cookie sessions on the Redis `SessionStore`** (AUTH-04/05/06).
   `config.stores.session = new RedisSessionStore(port)` in
   [`src/server.ts`](./src/server.ts). The pipeline's `authenticate` phase loads the
   session per request and slides the idle TTL (clamped to the absolute ceiling).
   Session lifecycle knobs are on `config.session`
   (`absoluteTtlSeconds`, `sameSite`), reused by the OIDC helpers via
   `toAuthConfig(config)`.

3. **S2S HMAC signing with a `signingPrincipalMapper`** (SIGN-*).
   `ImportNotes` carries `@sigv4Hmac`. `config.signing.acceptanceWindowSeconds = 300`
   sets the ±window; `config.signingPrincipalMapper` (in `config.ts`) maps a verified
   keyId → a scoped **service** `Principal` holding `notes.import`. The signing key
   is resolved by `config.stores.secrets = new NodeSecretProvider(envSecretSource(), …)`
   — the adapter-node provider, seeded by the OPS-03 key tool (see below). Because
   `ImportNotes` is **not** `@readonly`, the verifier requires a `NonceStore`
   (`config.stores.nonce = new RedisNonceStore(port)`) for replay defense (RT-06).

4. **Resource policy (`isOwner`)** (AUTHZ-03/06).
   `requireResourcePolicy(isOwner(), { load })` is dropped into the `GetNote` /
   `DeleteNote` per-op middleware slots in `createApp.ts`. `load` fetches the note so
   `isOwner` compares `note.ownerId === principal.id`: a missing note → **404**, a
   note owned by someone else → **403** — even when the caller holds the operation
   permission.

5. **CSRF issuance + enforcement** (CSRF-03).
   The callback returns the session's CSRF token; `GET /csrf-token` re-issues it for
   an authed SPA. The pipeline's `csrf` phase enforces an `X-CSRF-Token` header on
   every state-changing **cookie-authed** request (`POST /notes`, `DELETE /notes/:id`,
   `POST /auth/logout`) — a missing/wrong token → **403 `CsrfFailed`**. Signed S2S
   requests are exempt (they carry no cookie).

6. **Concrete `AuditSink`** (OPS-05, LOG-10).
   `config.audit = createStdoutAuditSink({ base: { service: 'secure-api' } })` — the
   adapter-node stdout JSON sink. The pipeline emits `auth.success` / `auth.failure` /
   `authz.deny` / `sig.fail` / `session.*` events through it; principal refs are
   pseudonymized with `config.auditSalt` (RT-12).

7. **`validateConfig` fail-fast at startup** (OPS-06).
   `createApp.ts` calls `validateConfig(OPERATIONS, config)` at construction. It throws
   a `ConfigValidationError` for an incoherent config — cookie ops with no session
   store, signed non-`@readonly` ops with no nonce/secret store, weak HSTS, wildcard
   CORS, or an incomplete `oidc` block — so a misconfiguration is caught at boot, not
   as a silent request-time 401.

The full pipeline (request-id, logging, error-sanitizer, security-headers,
assert-https, CORS, body-guards, per-IP rate-limit, authenticate, verify-signature,
CSRF, per-principal rate-limit) is composed once by
`createSecurityPipeline(OPERATIONS, config)`.

---

## Generated vs hand-wired

- **Generated** (from the model, via the codegen plugin): the Zod schemas, typed
  error classes, the `OPERATIONS` registry, and the `createNoteRouter` factory with
  its `authorize(OPERATIONS.X)` hooks and per-op middleware slots
  (`generated/*.gen.ts`).
- **Hand-wired** (app code, as intended): the security pipeline composition, the
  OIDC route mounting, and the `requireResourcePolicy(isOwner())` drops into the
  generated slots — exactly the seam the framework leaves to the integrator
  (AUTHZ-09).

---

## Running it

### Env vars

| Var | Required | Purpose |
| --- | --- | --- |
| `REDIS_URL` | ✅ | `redis://host:6379` — session + nonce backend |
| `OIDC_ISSUER` | ✅ | IdP issuer URL (discovery + `iss`) |
| `OIDC_CLIENT_ID` | ✅ | registered client id / expected `aud` |
| `OIDC_CLIENT_SECRET` | — | confidential-client secret (omit for public PKCE) |
| `OIDC_REDIRECT_URI` | ✅ | where `/auth/callback` is reachable |
| `OIDC_AUTHORIZE_URL` | ✅ | IdP authorize endpoint |
| `OIDC_TOKEN_URL` | ✅ | IdP token endpoint |
| `OIDC_STATE_SECRET` | ✅ | HMAC secret for the login↔callback tx cookie |
| `AUDIT_SALT` | — | per-deployment pseudonymization salt (RT-12) |
| `SIGNING_KEY_<KEYID>` | — | base64 raw HMAC bytes for an S2S client key |
| `IMPORTER_CLIENT_ID` / `IMPORTER_KEY_ID` | — | S2S client + current keyId (defaults `importer` / `importer-v1`) |
| `ALLOWED_ORIGINS` | — | comma-separated CORS origins |
| `TRUST_PROXY_HEADERS` | — | `1` behind a trusted proxy that sets `X-Forwarded-*` |

### Redis via docker-compose

Mirror the `deploy/node` topology with a one-line compose (Redis only — the app runs
from your shell):

```yaml
# docker-compose.yml
services:
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
```

```sh
docker compose up -d redis        # or: docker run --rm -d -p 6379:6379 redis:7-alpine
export REDIS_URL=redis://localhost:6379
```

### Seeding S2S keys with the key tool (OPS-03)

The S2S signing key is provisioned with `@smithy-hono/key-tool`, which writes the
key material into the SAME Redis (`docs/key-lifecycle.md`):

```sh
export REDIS_URL=redis://localhost:6379
npx key-tool provision importer     # prints { keyId, material } ONCE
```

Then make the material resolvable by the server. Two options:

- **Env source (default here):** export `SIGNING_KEY_<KEYID>` with the base64
  material, and set `IMPORTER_KEY_ID=<keyId>`. The server's
  `NodeSecretProvider(envSecretSource(), …)` reads it. For the printed
  `importer.<hex>` keyId, the env var is `SIGNING_KEY_IMPORTER_<HEX>` (uppercased,
  non-alphanumerics → `_`).
- **Redis source:** swap `envSecretSource()` for `redisSecretSource(port)` in
  `src/server.ts` so the provider reads the key tool's Redis material directly — then
  no env var is needed. Rotation (`key-tool rotate importer`) keeps the previous key
  alive for the overlap window so in-flight requests still verify.

### Boot

```sh
export OIDC_ISSUER=https://your-idp.example.com
export OIDC_CLIENT_ID=secure-api
export OIDC_REDIRECT_URI=https://localhost:3000/auth/callback
export OIDC_AUTHORIZE_URL=$OIDC_ISSUER/authorize
export OIDC_TOKEN_URL=$OIDC_ISSUER/token
export OIDC_STATE_SECRET=$(openssl rand -base64 32)
npm run start:redis
curl -fsS http://localhost:3000/healthz     # → 200 {"status":"ok"}
```

> The OIDC verifier is built at boot against the IdP's discovery + JWKS. On a
> constrained network (or without a real IdP), use the in-test fake issuer path — see
> below.

---

## Tests

```sh
npm install            # installs the packed security-core + adapter-node tarballs
npm test               # vitest, in-memory stores + a fake OIDC issuer (CI-safe, no Redis)
npm run typecheck      # tsc --noEmit
```

[`test/security-e2e.test.ts`](./test/security-e2e.test.ts) exercises the secured
flows through the SAME `createSecureApp` factory the Redis deployment boots, with
in-memory stores and a fake `OidcVerifier` (the IdP-unavailable path —
[`test/harness.ts`](./test/harness.ts)):

| Scenario | Expected |
| --- | --- |
| unauthenticated request to a cookie op | 401 `Unauthorized` |
| session-authed `CreateNote` with CSRF token | 201 (ownerId = caller) |
| cookie-authed mutation **without** CSRF token | 403 `CsrfFailed` |
| principal missing `notes.write` | 403 `AccessDenied` (operation tier) |
| `isOwner`: owner reads own note | 200 |
| `isOwner`: other user reads the note | 403 `AccessDenied` (resource tier) |
| `isOwner`: missing note | 404 `NotFound` |
| valid S2S signature | 200 |
| tampered body / wrong key / stale timestamp | 401 |
| replay of a signed request (nonce-tracked) | first 200, replay 401 |
| OIDC login → callback round trip (fake issuer) | session minted, CSRF returned |
| `validateConfig` with a missing nonce store | throws at construction |

All 18 cases run with no Redis and no IdP. Guard a live-Redis variant behind
`REDIS_URL` exactly as the adapter live tests do if you want to exercise the real
stores.

> **Known note (not introduced here):** `security-core`'s OWN `oidc.test.ts` /
> `routes.test.ts` hit a `jose` env CryptoKey mismatch under tsc in some
> environments. That does not affect this example: the runtime/build is fine, and the
> e2e test uses an injected fake `OidcVerifier` so it never depends on a real `jose`
> verification at test time.
