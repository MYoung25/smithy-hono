# @smithy-hono/adapter-cf

Cloudflare runtime adapter for [`@smithy-hono/security-core`](../security-core)
(Phase S10 Part B). Implements the four storage interfaces and the platform glue
against **Workers KV + Durable Objects**, over narrow *structural ports* so
nothing here imports a Cloudflare SDK at runtime (ARCH-01).

| Concern         | Backend                         | Class / fn                       | Consistency |
|-----------------|---------------------------------|----------------------------------|-------------|
| `SessionStore`  | Workers KV                      | `KvSessionStore`                 | eventual (accepted) |
| `RateLimitStore`| Durable Object                  | `DurableRateLimitStore`          | **strong** (required) |
| `NonceStore`    | Durable Object                  | `DurableNonceStore`              | **strong** (required) |
| `SecretProvider`| Workers env secrets             | `EnvSecretProvider`              | — |
| forwarded-proto | `CF-Visitor` → `X-Forwarded-Proto` | `forwardedProtoHeader(c)`      | — |
| client IP       | `CF-Connecting-IP`              | `clientIp(c)`                    | — |
| logger sink     | `console` → Logpush             | `createConsoleLogger()`          | — |

## The PORT pattern

The stores never touch `@cloudflare/workers-types`. They depend on minimal
**structural** interfaces; a consumer's real bindings satisfy them by shape.

- `KvNamespaceLike` — `{ get(key), put(key, value, { expirationTtl? }), delete(key) }`
  (a Workers `KVNamespace` is a structural superset).
- `DurableStorageLike` — `{ get<T>(key), put(key, value), delete(key) }`
  (a `DurableObjectStorage` is a structural superset).
- `DurableObjectStubLike` — `{ fetch(Request): Promise<Response> }`
  (the stub from `env.SECURITY_DO.get(id)` is a structural superset).

The token-bucket arithmetic lives in **one** pure function,
`computeTokenBucket(state, cost, spec, nowMs)`, called by both the Durable Object
logic and the in-process fake — a single source of truth, unit-tested directly.

## Consumer wiring (Workers)

```ts
import {
  KvSessionStore,
  DurableRateLimitStore, DurableNonceStore,
  SecurityDurableObject,
  createFetchRateLimitStub, createFetchNonceStub,
  EnvSecretProvider,
  forwardedProtoHeader, clientIp, createConsoleLogger,
} from '@smithy-hono/adapter-cf'

// Re-export the DO so wrangler can bind it.
export { SecurityDurableObject }

export default {
  async fetch(req: Request, env: Env) {
    // Sessions → KV (env.SESSIONS is a KVNamespace).
    const sessions = new KvSessionStore(env.SESSIONS)

    // Rate-limit + nonce → Durable Object. Route each KEY to the DO that owns it
    // via idFromName(key) so a single bucket/nonce lives on a single serial object.
    const rateLimit = new DurableRateLimitStore((key) =>
      createFetchRateLimitStub(env.SECURITY_DO.get(env.SECURITY_DO.idFromName(key))))
    const nonces = new DurableNonceStore((nonce) =>
      createFetchNonceStub(env.SECURITY_DO.get(env.SECURITY_DO.idFromName(nonce))))

    // Signing keys: raw HMAC material from env secrets (hex), never in code.
    const secrets = new EnvSecretProvider(
      { 'key-2026a': env.HMAC_KEY_2026A }, // hex-encoded
      { 'client-x': 'key-2026a' },
    )

    const config = {
      // ...SecurityConfig...
      stores: { session: sessions, rateLimit, nonce: nonces, secrets },
      logger: createConsoleLogger(),
      forwardedProtoHeader, // TransportConfig hook
      clientIp,             // RateLimitConfig hook
    }
    // ...mount the security-core pipeline with `config`...
  },
}
```

`wrangler.toml`:

```toml
[[durable_objects.bindings]]
name = "SECURITY_DO"
class_name = "SecurityDurableObject"

[[kv_namespaces]]
binding = "SESSIONS"
id = "..."

# HMAC_KEY_2026A is a `wrangler secret`, never committed.
```

## Why the strong-consistency stores are correct

Cloudflare runs each Durable Object **single-threaded and serial** — one request
to an object at a time. A `consume` / `checkAndStore` read-modify-write therefore
executes atomically against other requests to the *same* object: no overspend, no
double-accept. The in-process fake reproduces this by funnelling calls through a
single promise chain (a serial gate), so the conformance suite exercises the
identical guarantee. This is why **rate-limit and nonce MUST be Durable Objects,
not KV** (plan/security/11 Part B; KV is eventually consistent).

## KV eventual-consistency note (SessionStore)

Workers KV is eventually consistent: a `put` can take up to ~60s to be globally
visible across edge PoPs. This is **accepted for sessions** per the plan — a brief
read-miss on a just-minted session degrades to a re-auth (not a security failure),
and revocation latency is bounded by the same window. The absolute-expiry ceiling
(AUTH-05) is enforced in-band on every read/touch, independent of KV's TTL, so the
session can never outlive its hard cap regardless of KV propagation. `touch`
re-`put`s with a fresh `expirationTtl` (KV has no native touch). KV's minimum TTL
is 60s; sub-minute idle windows rely on the in-band guard, which is authoritative.

## Optional `@cloudflare/workers-types`

This package deliberately does **not** depend on `@cloudflare/workers-types` — it
defines its own minimal structural platform types so it typechecks and tests with
root-hoisted tooling only. A consuming Worker project will already have the
ambient types; nothing here needs them.

## Audit sink, metrics & retention (OPS-05, LOG-08/10/12)

security-core emits two structured streams that this package gives a Cloudflare
transport, both as one JSON line per record via `console.log`. On Workers,
`console` output is captured by **Logpush** (Workers Trace Events Logpush) and
delivered to the configured destination (R2, an HTTP endpoint, a SIEM):

- **`createConsoleAuditSink()`** → `config.audit`. A concrete `AuditSink` for the
  typed audit trail (`auth.failure`, `authz.deny`, `ratelimit.trip`, `sig.fail`,
  `session.*`, `key.rotate`). Lines tagged `kind: "audit"`.
- **`createConsoleMetricsSink()`** → `config.metrics`. A concrete `MetricsSink` for
  the LOG-08 operational signals (`http.5xx`, `ratelimit.saturation`,
  `cert.expiry`). Lines tagged `kind: "metric"`.

```ts
import {
  createConsoleAuditSink,
  createConsoleMetricsSink,
} from '@smithy-hono/adapter-cf'
import { ChainedAuditSink } from '@smithy-hono/security-core'

const config = {
  // ...stores, logger, etc.
  audit: createConsoleAuditSink({ base: { service: 'todo-api' } }),
  metrics: createConsoleMetricsSink({ base: { service: 'todo-api' } }),
}
// Opt-in LOG-12 tamper-evidence (default off):
//   audit: new ChainedAuditSink(createConsoleAuditSink())
```

**Point it at a real destination (deploy-config, no code change):** enable a
Logpush job for the Worker and route on the `kind` discriminator — ship
`kind: "audit"` to R2 with **Object-Lock** (the WORM / 1-yr audit baseline) or a
SIEM, distinctly from `kind: "metric"` and ordinary request logs. Convert the
metric lines downstream into a `http.5xx` rate, a `ratelimit.saturation` rate, and
a `cert.expiry` gauge to alert on. Optional: ship metrics to **Workers Analytics
Engine** instead by passing a `MetricsSink` that calls `writeDataPoint` (a drop-in;
needs an AE binding, so it is out of scope here).

**Cert-expiry hook (LOG-08/TLS-05):** Cloudflare terminates TLS at the edge, so
core cannot read the cert. A Worker **cron trigger** computes seconds-remaining and
calls `emitCertExpiry(metricsSink, { subject, secondsRemaining })`.

**Retention (deploy-config baseline):** **1 year for audit (`kind: "audit"`),
90 days for request logs / metrics** — enforced at the Logpush destination
(R2 lifecycle / Object-Lock retention, SIEM policy), never in code, and overridable
per deployment. Sampling MAY apply to request logs but MUST NOT apply to audit
events (LOG-06).

## Test / verify

```
npx tsc --noEmit -p tsconfig.json   # types
npx vitest run                      # conformance + unit
```

Conformance suites (from `@smithy-hono/security-core/storage/conformance`) run
against the fake-backed stores: `describeSessionStore`, `describeRateLimitStore`
(incl. no-overspend), `describeNonceStore` (incl. exactly-once).

## Live verification (miniflare)

`src/live.miniflare.test.ts` (gated on `CF_LIVE=1`) runs the SAME conformance
suites against a **real Workers runtime** via in-process miniflare — a real KV
namespace (sessions) and a real **Durable Object** (rate-limit + nonce), exercising
genuine serial dispatch over the `fetch` hop and `idFromName` routing. A tiny
worker (bundled at runtime with esbuild) exposes a DO class delegating to the
adapter's `SecurityDurableObject` logic. Run it locally with
`./scripts/verify-live.sh` or in CI via `.github/workflows/live-conformance.yml`
(no Docker — miniflare is in-process).

The only thing still unexercised is a genuinely **edge-deployed** Worker
(production cross-isolate placement), which is a deploy-smoke concern rather than
adapter logic.
