# @smithy-hono/adapter-node

Node / Redis runtime adapter for [`@smithy-hono/security-core`](../security-core).
It implements the four storage interfaces (Phase S0) against Redis, plus the Node
platform glue, without importing a Redis SDK at runtime (ARCH-01).

| Concern | Backend | Mechanism | Consistency |
|---|---|---|---|
| `SessionStore` | Redis | `SET` (JSON) `PX`, `GET`, `DEL`, `PEXPIRE` (touch) | strong |
| `RateLimitStore` | Redis | atomic token-bucket `EVAL` (Lua) | **strong — no overspend** |
| `NonceStore` | Redis | `SET key val NX PX` first-write-wins | **strong — exactly-once** |
| `SecretProvider` | injected secret source | `crypto.subtle.importKey` HMAC `['verify']` | n/a |
| forwarded-proto | `X-Forwarded-Proto` | header read | — |
| client IP | `X-Forwarded-For` | leftmost / trusted-hop | — |
| logger sink | stdout | one JSON line via `console.log` | — |

Redis is strongly consistent, so **all four** are exact — including `SessionStore`.
This contrasts with the Cloudflare adapter, where KV is acceptable for sessions
but Durable Objects are required for rate-limit/nonce; here Redis covers all four.

> **CRUD `DataStore<T>` note (Plan 13 D7).** This package also ships a Redis-backed
> `DataStore<T>` (`createRedisDataStore`), but it is **not** the durable default.
> For durable CRUD use [`@smithy-hono/adapter-postgres`](../adapter-postgres) — the
> **recommended store of record** for the Node deployment (durable, rich JSONB
> list/filter/count, no client scan). The Redis `DataStore` is the optional
> **cache-grade** alternative (RAM-bound; declared-index SETs + a capped scan for
> filters) — for ephemeral/cache-like entities or shops already on Redis. The
> security stores above are unaffected: Redis remains correct there.

## The port pattern

Stores never import `ioredis`. They depend on a narrow structural **`RedisPort`**
(`get`, `set` with `{ pxMillis, ifNotExists }`, `del`, `pexpire`,
`evalTokenBucket`). Two implementations satisfy it:

- **`createRedisPort(client)`** — production. Maps the port onto a structural
  `RedisClientLike` you supply (an `ioredis` client satisfies it as-is). No SDK
  is bundled, so the package typechecks and publishes without `ioredis`.
- **`createFakeRedisPort()`** (`@smithy-hono/adapter-node/test-support`) — an
  in-process `Map` honoring the SAME atomicity contract synchronously (one JS
  tick == atomic). It backs the conformance suites and is for tests only.

### `RedisClientLike` (what the consumer satisfies)

```ts
interface RedisClientLike {
  get(key): Promise<string | null>
  set(key, value, ...args): Promise<string | null>   // ioredis variadic: 'PX', ms, 'NX'
  del(key): Promise<number>
  pexpire(key, ms): Promise<number>
  eval(script, numKeys, ...keysAndArgs): Promise<unknown>
}
```

Command set used: **`GET`, `SET` (with `PX`/`NX`), `DEL`, `PEXPIRE`, `EVAL`**.
An `ioredis` client matches directly; `node-redis` v4 needs a thin shim (its
`set` takes an options object and returns `'OK' | null`).

## Wiring (production)

```ts
import Redis from 'ioredis'
import {
  createRedisPort,
  RedisSessionStore, RedisRateLimitStore, RedisNonceStore,
  NodeSecretProvider, recordSecretSource,
  forwardedProtoHeader, clientIpResolver, createStdoutLogger,
} from '@smithy-hono/adapter-node'

const port = createRedisPort(new Redis(REDIS_URL))

const stores = {
  session:   new RedisSessionStore(port),
  rateLimit: new RedisRateLimitStore(port),
  nonce:     new RedisNonceStore(port),
}

// Keys never live in code (SIGN-06): load base64 HMAC material from your secret
// manager / mounted k8s secret into a record, or use envSecretSource().
const secrets = new NodeSecretProvider(
  recordSecretSource(loadedKeyRecord), // { keyId: base64RawHmacBytes }
  { currentKeyByClient: { 'client-a': 'key-2026-06' } },
)

const config = {
  // ...SecurityConfig...
  forwardedProtoHeader,                       // TransportConfig hook (TLS-03)
  clientIp: clientIpResolver({ trustedHops: 1 }), // RateLimitConfig hook (RATE-01)
  logger: createStdoutLogger({ base: { service: 'todo-api' } }),
  stores: { ...stores, secrets },
}
```

### Trust boundaries (read this)

- **`forwardedProtoHeader`** reads `X-Forwarded-Proto`. It is client-spoofable
  unless the request *actually* traversed a trusted proxy that overwrites it.
  Mount `assertHttps` with it ONLY when the service is reachable solely through
  such a proxy. Absence → `undefined` → `assertHttps` rejects (fails closed).
- **`clientIp` / `clientIpResolver`** read `X-Forwarded-For`, a client-controlled
  chain `client, proxy1, proxy2`. Default takes the **leftmost** entry, correct
  only behind a single trusted proxy that owns XFF. Behind N trusted proxies set
  `trustedHops: N` to take the entry the outermost trusted hop observed rather
  than an attacker-supplied leftmost value. A directly-exposed Node process must
  NOT trust XFF — front it with a proxy first.

### Secrets

`SecretSourceLike` is `{ get(keyId): Promise<string | null> }` returning the
**base64-encoded** raw HMAC bytes. Supply it via `recordSecretSource(record)`
(an already-loaded record) or `envSecretSource()` (reads `process.env`, the only
`process.env` access in the package, isolated to `secretsEnv.ts`; keys map to
`SIGNING_KEY_<NORMALIZED_KEYID>`). Rotation (SIGN-05): keep the previous keyId in
the source within the acceptance window so `getSigningKey` still verifies it;
`getCurrentKeyId` resolves the newest via the `currentKeyByClient` map.

## Rate-limit math is one source of truth

`computeTokenBucket(state, cost, spec, nowMs)` is the pure, unit-tested decision
function. The Redis Lua in `TOKEN_BUCKET_LUA` is a line-for-line mirror of it
(cross-referenced in a comment so they cannot silently diverge), run inside a
single `EVAL` — that single-script execution is what makes the read-modify-write
atomic on the server, so concurrent callers cannot overspend a bucket.

## Validation split (local fake vs. live CI)

- **Local / this package's tests** validate all adapter logic and the *atomicity
  contract* against the in-process fake port: the conformance suites (including
  no-overspend and exactly-once) pass because the fake mirrors Redis atomicity
  synchronously. `computeTokenBucket` and the glue resolvers are unit-tested
  directly. Run with root-hoisted tooling only — no Redis, no `ioredis` install.
- **Live Redis** (`src/live.redis.test.ts`, gated on `REDIS_URL`) runs the SAME
  conformance suites through `createRedisPort` against a real Redis — validating
  the Lua `EVAL` and `SET NX` server-side. Run it locally with
  `./scripts/verify-live.sh` (Redis in Docker) or in CI via
  `.github/workflows/live-conformance.yml` (Redis service container).

## Audit sink, metrics & retention (OPS-05, LOG-08/10/12)

security-core emits two structured streams that this package gives a Node
transport, both as one JSON line per record on **stdout** (`console.log`) — the
Node convention where a log shipper (Fluent Bit / Vector / the container runtime /
k8s) tails stdout and forwards to a collector (Loki, Elasticsearch, a SIEM):

- **`createStdoutAuditSink()`** → `config.audit`. A concrete `AuditSink` for the
  typed audit trail (`auth.failure`, `authz.deny`, `ratelimit.trip`, `sig.fail`,
  `session.*`, `key.rotate`). Each line is tagged `kind: "audit"`.
- **`createStdoutMetricsSink()`** → `config.metrics`. A concrete `MetricsSink` for
  the LOG-08 operational signals (`http.5xx`, `ratelimit.saturation`,
  `cert.expiry`). Each line is tagged `kind: "metric"`.

```ts
import {
  createStdoutAuditSink,
  createStdoutMetricsSink,
} from '@smithy-hono/adapter-node'
import { ChainedAuditSink } from '@smithy-hono/security-core'

const config = {
  // ...stores, logger, etc.
  audit: createStdoutAuditSink({ base: { service: 'todo-api', env: 'prod' } }),
  metrics: createStdoutMetricsSink({ base: { service: 'todo-api' } }),
}
// Opt-in LOG-12 tamper-evidence (default off):
//   audit: new ChainedAuditSink(createStdoutAuditSink())
```

**Point it at a real destination (deploy-config, no code change):** route on the
`kind` discriminator in your collector — send `kind: "audit"` to a WORM /
long-retention index (e.g. an object store with Object-Lock) distinctly from
`kind: "metric"` and ordinary request logs. Convert the `kind: "metric"` lines to
counters/gauges with a stdout-scraping exporter or Vector's `log_to_metric` and
alert on a `http.5xx` rate, a `ratelimit.saturation` rate, and a `cert.expiry`
gauge threshold. A file/syslog variant is intentionally left to the collector
(keeps the adapter `node:*`-free, ARCH-01). Optional Kinesis/SIEM fan-out is also a
collector concern.

**Cert-expiry hook (LOG-08/TLS-05):** core cannot read a TLS cert (terminated at
the LB/ingress). A scheduled probe (a cron/sidecar) computes seconds-remaining and
calls `emitCertExpiry(metricsSink, { subject, secondsRemaining })` so the same
pipeline alerts when it drops below a threshold.

**Retention (deploy-config baseline):** **1 year for audit (`kind: "audit"`),
90 days for request logs / metrics** — enforced at the destination's lifecycle
policy (object-store lifecycle, log-group retention), never in code, and
overridable per deployment. Audit retention should sit on immutable/WORM storage;
sampling MAY be applied to request logs but MUST NOT be applied to audit events
(LOG-06).

## Verify

```sh
npx tsc --noEmit -p tsconfig.json
npx vitest run
```

`ioredis` is an OPTIONAL peer dependency — install it only in the consuming
service; it is not needed to typecheck or test this package.
