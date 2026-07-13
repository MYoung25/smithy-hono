# @smithy-hono/adapter-aws

AWS runtime adapter for [`@smithy-hono/security-core`](../security-core). Implements
the four storage interfaces (ARCH-03) against AWS backends — **DynamoDB** for the
session / rate-limit / nonce stores, **Secrets Manager** for HMAC signing keys —
plus the platform glue (forwarded-proto resolver, client-IP resolver, CloudWatch
logger).

**Rate-limit and nonce stores are strongly consistent** (plan 11 mandate): DynamoDB
conditional writes / optimistic-concurrency CAS, so a single logical bucket never
overspends and a nonce is accepted exactly once.

## Dependency discipline (ARCH-01)

This package **does not import `@aws-sdk/*`**. The stores depend only on a narrow
structural `DynamoTablePort`; the real port talks to DynamoDB through a structural
`DynamoSendLike` client, and the SecretProvider through a structural
`SecretsSourceLike`. So it typechecks and runs its full test suite with no AWS SDK
installed. The SDK packages are listed as **optional peer dependencies**; install
them only in your consumer service:

```
@aws-sdk/client-dynamodb        (optional peer)
@aws-sdk/lib-dynamodb           (optional peer — recommended: DocumentClient)
@aws-sdk/client-secrets-manager (optional peer)
```

## Public exports

| Export | Purpose |
|--------|---------|
| `DynamoSessionStore` | `SessionStore` over the port |
| `DynamoRateLimitStore` | `RateLimitStore` (strongly-consistent token bucket via CAS) |
| `DynamoNonceStore` | `NonceStore` (first-write-wins conditional put) |
| `SecretsManagerSecretProvider` | `SecretProvider` over Secrets Manager |
| `createDynamoTablePort(client, tableName)` | real DynamoDB port |
| `computeTokenBucket(state, cost, spec, nowMs)` | pure token-bucket math |
| `awsForwardedProto(opts?)` | `TransportConfig.forwardedProtoHeader` resolver |
| `awsClientIp(opts?)` | `RateLimitConfig.clientIp` resolver |
| `createConsoleLogger(sink?)` | structured `Logger` → CloudWatch |
| types | `DynamoTablePort`, `ItemKey`, `DynamoSendLike`, `SecretsSourceLike`, `DynamoSecretProviderOptions`, `BucketState`, `BucketResult`, `PK_ATTR`/`TTL_ATTR`/`VERSION_ATTR` |

`./test-support` entry: `FakeDynamoTablePort`, `FakeSecretsSource` — in-process
fakes with the same conditional/CAS atomicity, for running the conformance suite
locally.

## Structural client interfaces the consumer satisfies

```ts
interface DynamoSendLike   { send(command: unknown): Promise<{ Item?: Record<string, unknown> } & Record<string, unknown>> }
interface SecretsSourceLike { getSecretString(secretId: string): Promise<string | null> }
```

## Required DynamoDB table schema

One physical table backs all three stores (keys are namespaced: `sess:` / `rl:` /
`nonce:`).

| Attribute | Type | Role |
|-----------|------|------|
| `pk` | String | **Partition key** (the only key attribute; no sort key) |
| `ttl` | Number | **TTL attribute** (epoch SECONDS) — enable DynamoDB TTL on it |
| `version` | Number | Optimistic-concurrency token — **managed by the port; do not touch** |

> DynamoDB TTL deletion is **eventual** (can lag the deadline by up to ~48h). The
> stores therefore carry a precise `expiresAtMs` (epoch millis) and perform an
> **in-code expiry check** on read — they never trust the backend to have swept a
> dead row. `ttl` exists only to let DynamoDB reclaim storage.

### Wiring the real port (DocumentClient recommended)

Because this package cannot import `@aws-sdk/lib-dynamodb`, `createDynamoTablePort`
hands `.send` a tagged plain command input (`{ __command: 'Put'|'Get'|'Update'|
'Delete', ...input }`). Supply a tiny `DynamoSendLike` that turns the tag into the
real command:

```ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, DeleteCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  createDynamoTablePort, DynamoSessionStore, DynamoRateLimitStore, DynamoNonceStore,
} from '@smithy-hono/adapter-aws'

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const sendLike = {
  send(cmd: any) {
    const { __command, ...input } = cmd
    const C = { Put: PutCommand, Get: GetCommand, Update: UpdateCommand, Delete: DeleteCommand }[__command]
    return doc.send(new C(input))
  },
}

const port = createDynamoTablePort(sendLike, process.env.SECURITY_TABLE!)
const stores = {
  session:   new DynamoSessionStore(port),
  rateLimit: new DynamoRateLimitStore(port),
  nonce:     new DynamoNonceStore(port),
}
```

> Reads use `ConsistentRead: true` and writes use `ConditionExpression`, satisfying
> the strong-consistency mandate. The CAS path retries on
> `ConditionalCheckFailedException` (bounded); under exhausted contention the
> rate-limit store fails safe by **denying** (never overspends).

### Wiring the SecretProvider

```ts
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { SecretsManagerSecretProvider } from '@smithy-hono/adapter-aws'

const sm = new SecretsManagerClient({})
const source = {
  async getSecretString(secretId: string) {
    const out = await sm.send(new GetSecretValueCommand({ SecretId: secretId }))
    return out.SecretString ?? null
  },
}

const secrets = new SecretsManagerSecretProvider(source, {
  keyIdToSecretId:      { 'k-2026-06': 'prod/sig/k-2026-06', 'k-2026-05': 'prod/sig/k-2026-05' },
  clientToCurrentKeyId: { 'svc-orders': 'k-2026-06' },
})
```

**Key material encoding:** the Secrets Manager secret **string** is the raw HMAC
key encoded as **base64**. It is imported via
`crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false,
['verify'])` — verify-only, non-extractable, cached per `keyId`. Keys never appear
in code or config (SIGN-06). During rotation, map both the current and previous
`keyId` to their secrets (SIGN-05); `getSigningKey` returns `null` for an
unknown/retired `keyId`.

### Wiring the glue

```ts
import { awsForwardedProto, awsClientIp, createConsoleLogger } from '@smithy-hono/adapter-aws'

const config = {
  // ...security-core config...
  forwardedProtoHeader: awsForwardedProto(),  // reads X-Forwarded-Proto
  clientIp:             awsClientIp(),         // leftmost X-Forwarded-For
  logger:               createConsoleLogger(), // JSON → CloudWatch
}
```

- **forwarded-proto:** defaults to `X-Forwarded-Proto` (ALB / API Gateway REST set
  it). **API Gateway HTTP API (payload v2.0)** may instead carry the scheme in the
  request context / `cloudfront-forwarded-proto` — pass
  `awsForwardedProto({ headerName: 'cloudfront-forwarded-proto' })` or supply your
  own resolver reading the `hono/aws-lambda` request context. Absent → `undefined`
  → `assertHttps` rejects (fail closed).
- **client IP:** leftmost `X-Forwarded-For`. **Trusted-hop assumption:** this is
  correct only because AWS edges (ALB / API Gateway) normalize the header; the
  value is client-spoofable behind an untrusted edge (e.g. a bare Lambda Function
  URL). Use `awsClientIp({ trustedHopsFromRight: n })` to take the Nth-from-right
  entry your trusted proxy appended, or your own resolver using the API Gateway
  request-context source IP.
- **logger:** one JSON line per record via `console.*` → CloudWatch Logs (queryable
  with Logs Insights).

## Local vs. CI validation split

**Validated here (this package's vitest, root tooling only — no AWS):**

- All three stores pass the security-core **conformance suite** against the
  `FakeDynamoTablePort` (same conditional/CAS atomicity), including the
  **no-overspend** (rate-limit) and **exactly-once** (nonce) strong-consistency
  assertions.
- `computeTokenBucket` pure math (allow/deny/refill/reset/retry-after).
- The real `createDynamoTablePort` over a structural `.send` mock that evaluates
  the `attribute_not_exists(pk)` / `version = :expected` ConditionExpressions —
  proving the conditional-put false return and the CAS retry/version logic.
- The glue resolvers and the Secrets Manager provider (HMAC import + verify).
- A **lightweight simulation** of the Lambda base64 event-body decode (below).

**Live DynamoDB** (`src/live.dynamodb.test.ts`, gated on `DYNAMODB_ENDPOINT`) runs
the SAME conformance suites through `createDynamoTablePort` against a real DynamoDB
(DynamoDB Local) — validating the conditional writes / version-CAS server-side
(no-overspend, exactly-once). Run it locally with `./scripts/verify-live.sh`
(DynamoDB Local in Docker) or in CI via `.github/workflows/live-conformance.yml`
(DynamoDB service container).

**Still deferred (needs a real AWS account, not just an engine):**

- True cross-*container* writer races (multiple Lambdas hammering one bucket/nonce)
  and DynamoDB **TTL sweep** timing — distributed/eventual behaviors only a real
  deployment shows; the live engine test exercises the CAS path and the in-code
  expiry guard.
- Secrets Manager fetch/caching against the **real service**.

### ARCH-08 Lambda raw-body — validated via the real adapter

The raw-body spike (`plan/security/11a-rawbody-spike-findings.md`) proved
`readRawBody(c)` (= `c.req.arrayBuffer()`) on Node and reasoned it correct on
Workers, but flagged **one Lambda-specific transform that cannot be exercised
without a real/SAM-local invoke**: `hono/aws-lambda` decodes API Gateway's
(possibly `isBase64Encoded`) event body and builds a Web `Request` whose body is
the **decoded** bytes — the bytes the client signed, which the SIGN-07 verifier
must hash.

This package now exercises that transform two ways: `src/lambdaRawBody.test.ts`
unit-simulates the base64 → decoded-bytes → `Request` math, and
`src/lambdaRawBody.real.test.ts` drives the **real `hono/aws-lambda` `handle()`**
with a base64 API Gateway event and asserts `readRawBody(c)` sees the decoded bytes
(hash matches) while `c.req.json()` still parses — the actual adapter decode path,
no Docker or AWS needed (`hono/aws-lambda` is a subpath of `hono`). The only thing
left is a genuinely **deployed** API Gateway → Lambda invoke (deploy smoke, not
adapter logic).

## Audit sink, metrics & retention (OPS-05, LOG-08/10/12)

security-core emits two structured streams that this package gives an AWS
transport, both as one JSON line per record via `console.log`. On Lambda,
`console` output lands in **CloudWatch Logs** (queryable with Logs Insights):

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
} from '@smithy-hono/adapter-aws'
import { ChainedAuditSink } from '@smithy-hono/security-core'

const config = {
  // ...stores, logger, etc.
  audit: createConsoleAuditSink({ base: { service: 'todo-api' } }),
  metrics: createConsoleMetricsSink({ base: { service: 'todo-api' } }),
}
// Opt-in LOG-12 tamper-evidence (default off):
//   audit: new ChainedAuditSink(createConsoleAuditSink())
```

Both factories accept an injectable `{ sink }` (a `{ log }` console-like) so tests
can capture lines; it defaults to the ambient `console`.

**Point it at a real destination (deploy-config, no code change):** add a
CloudWatch Logs **subscription filter** that fans the lines, routed on the `kind`
discriminator — `kind: "audit"` to **Kinesis Data Streams / Firehose → S3 with
Object-Lock** (the WORM / 1-yr audit baseline) or a SIEM, distinctly from
`kind: "metric"` and ordinary request logs. Turn the metric lines into a `http.5xx`
rate, a `ratelimit.saturation` rate, and a `cert.expiry` gauge with CloudWatch
metric filters / alarms. Optional: emit metrics as **CloudWatch EMF** (a drop-in
`MetricsSink` that formats the embedded-metric envelope) so CloudWatch
auto-extracts the metrics.

**Cert-expiry hook (LOG-08/TLS-05):** ACM/ALB terminates TLS, so core cannot read
the cert. A **scheduled EventBridge → Lambda** computes seconds-remaining and calls
`emitCertExpiry(metricsSink, { subject, secondsRemaining })` (ACM already publishes
`DaysToExpiry`; this keeps the signal in one pipeline).

**Retention (deploy-config baseline):** **1 year for audit (`kind: "audit"`),
90 days for request logs / metrics** — enforced at the destination (S3 lifecycle /
Object-Lock retention, log-group retention, SIEM policy), never in code, and
overridable per deployment. Sampling MAY apply to request logs but MUST NOT apply
to audit events (LOG-06).

## Build / test

```
npm run build       # tsc -p tsconfig.build.json → dist
npm test            # vitest run
npm run typecheck   # tsc --noEmit
```
