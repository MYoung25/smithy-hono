# aws / CDK deployment (OPS-02)

Runnable infrastructure-as-code for the **AWS** adapter
([`@smithy-hono/adapter-aws`](../../packages/adapter-aws)): an **AWS CDK
(TypeScript)** app that provisions the DynamoDB table, the Secrets Manager
signing key(s), and a sample Lambda — with least-privilege IAM — that wires the
adapter into the `@smithy-hono/security-core` pipeline.

The table schema is dictated by the adapter, not invented here: PK `pk`, TTL on
`ttl`, on-demand — **the exact schema the live-conformance backend uses**
(`.github/workflows/live-conformance.yml` → `amazon/dynamodb-local`, exercised by
`packages/adapter-aws/src/live.dynamodb.test.ts`).

## What's here

| File | Purpose |
| --- | --- |
| `bin/app.ts` | CDK app entrypoint. Reads `signingKeyIds` / `secretPrefix` / `signingClientId` from CDK context (`cdk.json` or `-c`). |
| `lib/security-backend-stack.ts` | The stack: DynamoDB table, Secrets Manager secret(s), the Lambda + IAM, a Function URL, and outputs. |
| `src/handler.ts` | The sample Lambda. Wires the adapter's three DynamoDB stores + the Secrets Manager key provider into `createSecurityPipeline`, exported via `hono/aws-lambda` `handle()`. |
| `src/operations.ts` | A minimal operation registry (one `sigv4Hmac` op) so the sample stands alone; swap in your codegen `OPERATIONS` (one-line import change). |
| `cdk.json` / `tsconfig.json` / `package.json` | CDK + TypeScript config. |

## The schema it provisions (matches the adapter exactly)

One **DynamoDB table** backs all three stores — session / rate-limit / nonce —
because each store namespaces its partition keys (`sess:` / `rl:` / `nonce:`):

| Attribute | Type | Role | Adapter source |
| --- | --- | --- | --- |
| `pk` | String | **Partition key** (only key attr; no sort key) | `PK_ATTR` — `packages/adapter-aws/src/port.ts:74` |
| `ttl` | Number | **TTL attribute** (epoch **seconds**) — DynamoDB TTL enabled on it | `TTL_ATTR` — `port.ts:72`, `dynamoPort.ts:21` |
| `version` | Number | Optimistic-concurrency token, a plain item attribute the **port** writes (not a key — no table schema) | `VERSION_ATTR` — `port.ts:70`, `dynamoPort.ts:87,114-115` |

- **Billing:** `PAY_PER_REQUEST` (on-demand), per the OPS-02 acceptance criteria.
- TTL deletion is **eventual**; the stores still do an in-code `expiresAtMs`
  expiry check on read, so `ttl` only reclaims storage (adapter README
  §"Required DynamoDB table schema").

**Secrets Manager** holds the HMAC signing key(s). Each keyId gets a secret named
`<secretPrefix>/<keyId>` (default `prod/sig/<keyId>` — the README wiring example,
`packages/adapter-aws/README.md:123`). The secret **string is the raw HMAC key
encoded as base64** (`secrets.ts:16-17`, decoded by `base64ToArrayBuffer` →
`crypto.subtle.importKey('raw', …)`, `secrets.ts:41-47,83-96`). CDK seeds a random
base64 placeholder so the stack deploys; **overwrite it with your real key before
signing real traffic** (below).

## Env vars the Lambda needs

Set automatically by the stack (`lib/security-backend-stack.ts`); the handler
(`src/handler.ts`) reads them:

| Env var | Set to | Read by |
| --- | --- | --- |
| `SECURITY_TABLE` | the table name | `createDynamoTablePort(client, tableName)` (`dynamoPort.ts:71`) |
| `SIGNING_KEY_IDS` | comma-separated keyIds, newest first | builds `keyIdToSecretId` (`secrets.ts:32,84`) |
| `SIGNING_SECRET_PREFIX` | `prod/sig` | builds each `secretId` = `<prefix>/<keyId>` |
| `SIGNING_CLIENT_KEY` | `<clientId>=<currentKeyId>` | builds `clientToCurrentKeyId` (`secrets.ts:34-35`) |
| `ALLOWED_ORIGINS` | (optional) comma-separated CORS origins | pipeline `allowedOrigins` |
| `AUDIT_SALT` | (optional, **set in prod**) principal-pseudonymization salt | `config.auditSalt` (LOG-11) |

During key rotation (SIGN-05), list **both** the current and previous keyId in
`SIGNING_KEY_IDS` so the previous key still verifies; the current (first) keyId is
what `SIGNING_CLIENT_KEY` maps the client to.

## How the handler composes the pipeline (raw-body + HMAC)

`src/handler.ts`:

1. Builds a `DynamoSendLike` that translates the adapter's tagged plain command
   inputs into real `DynamoDBDocumentClient` commands (the adapter never imports
   `@aws-sdk/*` — ARCH-01; the consumer supplies the client). It wraps the three
   stores: `DynamoSessionStore` / `DynamoRateLimitStore` / `DynamoNonceStore`.
2. Builds a `SecretsManagerSecretProvider` over a `SecretsSourceLike` that calls
   `GetSecretValueCommand`.
3. Assembles the `PipelineConfig` (stores + AWS glue: `awsForwardedProto`,
   `awsClientIp`, `createConsoleLogger`), calls `validateConfig` at cold start to
   fail fast, then mounts `createSecurityPipeline(OPERATIONS, config)` and exports
   `handle(app)`.

**Raw-body + HMAC:** `hono/aws-lambda` `handle()` decodes the API Gateway event
body (including `isBase64Encoded`) into the Web `Request` body — the bytes the
client signed. The S6 `verifySignature` phase reads them via `readRawBody(c)` to
re-derive the HMAC body hash (ARCH-08 / SIGN-07). This mirrors the adapter's own
real-Lambda decode test (`packages/adapter-aws/src/lambdaRawBody.real.test.ts`),
so the signed-request path is correct end-to-end with no extra plumbing. The
sample's `POST /orders` op is `sigv4Hmac` + non-readonly, so it is nonce-tracked
(replay protection) against the DynamoDB nonce store.

## Deploy

### Prerequisites

- Node ≥ 24, AWS credentials configured (`aws configure` / SSO / env).
- The AWS CDK CLI is a devDependency (`npx cdk …` works after install).

### Steps

```bash
cd deploy/aws
npm install                 # also builds the local @smithy-hono/* deps
npx cdk bootstrap           # once per account/region (CDK toolkit stack)
npx cdk deploy              # provisions the table, secret(s), Lambda + IAM
```

Override the signing config via context, e.g. a rotation window with two keys:

```bash
npx cdk deploy \
  -c signingKeyIds=k-2026-06,k-2026-05 \
  -c secretPrefix=prod/sig \
  -c signingClientId=svc-orders
```

`cdk deploy` outputs `TableName`, `FunctionName`, `FunctionUrl`, and
`SigningSecretNames`.

### Seeding the signing secret(s)

The stack seeds a **random placeholder**; replace it with the real base64 HMAC
key (same encoding the live-conformance/local tests use — `head -c32 /dev/urandom
| base64`):

```bash
aws secretsmanager put-secret-value \
  --secret-id prod/sig/k-demo-1 \
  --secret-string "$(head -c 32 /dev/urandom | base64)"
```

Use the **same** base64 key material on the signing client so its HMAC verifies.

### Smoke

The Lambda has a Function URL (printed as `FunctionUrl`). `GET <url>/healthz`
returns liveness. A signed `POST <url>/orders` exercises the raw-body + HMAC path.

> **Trusted-edge caveat:** a bare Function URL is **not** a trusted edge —
> `awsClientIp` then trusts a client-spoofable `X-Forwarded-For` (`glue.ts:53-61`)
> and `awsForwardedProto` a spoofable `X-Forwarded-Proto`. Front the Lambda with
> **API Gateway / ALB** in production (those normalize the headers), or pass
> `awsClientIp({ trustedHopsFromRight })` / a request-context resolver.

## Cleanup

```bash
npx cdk destroy
```

The table and secrets use `RemovalPolicy.DESTROY` (demo default — set `RETAIN` in
`lib/security-backend-stack.ts` for production data).

## Local validation done in this repo

`npm install` + `npx tsc --noEmit` + `npx cdk synth` all pass locally (no AWS
account needed for synth). The synthesized template confirms the DynamoDB schema
(`pk`/`ttl`/`PAY_PER_REQUEST`), the `prod/sig/<keyId>` secret, the least-privilege
IAM (table read/write + `secretsmanager:GetSecretValue`), and the Lambda env vars.
`cdk deploy` against a real account was **not** run here (no credentials).
