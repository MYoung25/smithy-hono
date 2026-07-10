/**
 * Sample AWS Lambda handler (OPS-02, AWS) — wires `@smithy-hono/adapter-aws`
 * into the security-core pipeline and exports a `hono/aws-lambda` `handle()`.
 *
 * This mirrors the adapter's own real-Lambda decode test
 * (packages/adapter-aws/src/lambdaRawBody.real.test.ts): `handle(app)` decodes
 * the (possibly `isBase64Encoded`) API Gateway event body and builds a Web
 * `Request` whose body is the DECODED bytes — the bytes the client signed. The
 * S6 `verifySignature` phase reads those raw bytes via `readRawBody(c)` to
 * re-derive the HMAC body hash (ARCH-08 / SIGN-07), so the raw-body+HMAC path is
 * correct end-to-end on Lambda with no extra plumbing here.
 *
 * Backends (all read from env injected by the CDK stack):
 *   - DynamoDB (one table) → session / rate-limit / nonce stores, via the
 *     adapter's `createDynamoTablePort` over a `DynamoDBDocumentClient`.
 *   - Secrets Manager → HMAC signing keys, via `SecretsManagerSecretProvider`.
 *
 * Env vars (set by lib/security-backend-stack.ts):
 *   SECURITY_TABLE         DynamoDB table name              (required)
 *   SIGNING_KEY_IDS        comma-separated keyIds, newest first
 *   SIGNING_SECRET_PREFIX  secret-name prefix, e.g. `prod/sig`
 *   SIGNING_CLIENT_KEY     `<clientId>=<currentKeyId>` for the demo S2S client
 *   ALLOWED_ORIGINS        comma-separated CORS origins (optional)
 *   AUDIT_SALT             principal-pseudonymization salt (optional; set in prod)
 *   TRUSTED_EDGE           `true` only when a trusted ALB / API Gateway / CloudFront
 *                          sits in front (it normalizes X-Forwarded-*). Defaults
 *                          to off: behind the bare Function URL the X-Forwarded-*
 *                          headers are client-spoofable, so we resolve the client
 *                          IP / scheme from the AWS request context instead.
 */

import { Hono } from 'hono'
import { handle } from 'hono/aws-lambda'

import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager'

import {
  createSecurityPipeline,
  validateConfig,
  healthHandler,
  type PipelineConfig,
  type SecurityEnv,
} from '@smithy-hono/security-core'
import {
  createDynamoTablePort,
  DynamoSessionStore,
  DynamoRateLimitStore,
  DynamoNonceStore,
  SecretsManagerSecretProvider,
  awsForwardedProto,
  awsClientIp,
  createConsoleLogger,
  type DynamoSendLike,
  type SecretsSourceLike,
} from '@smithy-hono/adapter-aws'

import { OPERATIONS } from './operations.js'

// --- env ---------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var ${name}`)
  return v
}

const TABLE_NAME = requireEnv('SECURITY_TABLE')
const SIGNING_KEY_IDS = (process.env.SIGNING_KEY_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const SIGNING_SECRET_PREFIX = process.env.SIGNING_SECRET_PREFIX ?? 'prod/sig'
// `<clientId>=<currentKeyId>` — the demo S2S client and the keyId it signs with.
const [SIGNING_CLIENT_ID, SIGNING_CURRENT_KEY] = (process.env.SIGNING_CLIENT_KEY ?? '').split('=')
// Only trust X-Forwarded-* when an explicit trusted edge (ALB / API Gateway /
// CloudFront) is declared. Defaults OFF so the bare-Function-URL deployment is
// secure-by-default (DEPLOY-INFRA-03): resolve IP/scheme from the request context.
const TRUSTED_EDGE = process.env.TRUSTED_EDGE === 'true'

// --- DynamoDB port -----------------------------------------------------------
// The adapter never imports the SDK (ARCH-01): we satisfy `DynamoSendLike` by
// translating its tagged plain command input into the real DocumentClient
// command (README §"Wiring the real port"; dynamoPort.ts:46-69).
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}))
type TaggedCommand = { __command: 'Put' | 'Get' | 'Update' | 'Delete' } & Record<string, unknown>
const sendLike: DynamoSendLike = {
  async send(cmd: unknown) {
    const { __command, ...input } = cmd as TaggedCommand
    // Dispatch per-kind so each `new *Command(input)` keeps its own input type
    // (a union of the four constructors confuses DocumentClient.send's overloads).
    switch (__command) {
      case 'Put':
        return doc.send(new PutCommand(input as never))
      case 'Get':
        return doc.send(new GetCommand(input as never))
      case 'Update':
        return doc.send(new UpdateCommand(input as never))
      case 'Delete':
        return doc.send(new DeleteCommand(input as never))
    }
  },
}
const port = createDynamoTablePort(sendLike, TABLE_NAME)

// --- Secrets Manager provider ------------------------------------------------
// keyId → secret name `<prefix>/<keyId>` (matches the CDK-created secret names);
// the demo client maps to the FIRST/current keyId (SIGN-05 rotation window —
// list both current and previous keyIds in SIGNING_KEY_IDS to keep verifying the
// previous one). secrets.ts:34-35,84.
const keyIdToSecretId: Record<string, string> = Object.fromEntries(
  SIGNING_KEY_IDS.map((keyId) => [keyId, `${SIGNING_SECRET_PREFIX}/${keyId}`]),
)
const sm = new SecretsManagerClient({})
const secretsSource: SecretsSourceLike = {
  async getSecretString(secretId: string) {
    const out = await sm.send(new GetSecretValueCommand({ SecretId: secretId }))
    return out.SecretString ?? null
  },
}
const secrets = new SecretsManagerSecretProvider(secretsSource, {
  keyIdToSecretId,
  clientToCurrentKeyId:
    SIGNING_CLIENT_ID && SIGNING_CURRENT_KEY ? { [SIGNING_CLIENT_ID]: SIGNING_CURRENT_KEY } : {},
})

// --- security pipeline config (ARCH-05) --------------------------------------
const config: PipelineConfig = {
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? 'https://example.com')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  hsts: { maxAge: 31_536_000, includeSubDomains: true },
  idleTtlSeconds: 900,
  session: { absoluteTtlSeconds: 8 * 60 * 60, sameSite: 'Lax' },
  // S2S HMAC signing policy: non-readonly signed ops are nonce-tracked by
  // default (replay protection), backed by the DynamoDB nonce store below.
  signing: { acceptanceWindowSeconds: 300 },
  // All three stores over the ONE DynamoDB table (keys namespaced by each store)
  // + the Secrets Manager HMAC key provider.
  stores: {
    session: new DynamoSessionStore(port),
    rateLimit: new DynamoRateLimitStore(port),
    nonce: new DynamoNonceStore(port),
    secrets,
  },
  // Default rate-limit buckets (the per-op `@cost` registry overrides at consume).
  rateLimits: {
    perIp: { capacity: 100, refillPerSecond: 2 },
    perPrincipal: { capacity: 1000, refillPerSecond: 20 },
  },
  auditSalt: process.env.AUDIT_SALT,
  maxInFlight: 200,
  requestTimeoutMs: 15_000,
  logger: createConsoleLogger(), // JSON → CloudWatch Logs (glue.ts).
  // AWS-edge glue: ALB / API Gateway set X-Forwarded-Proto and normalize
  // X-Forwarded-For (glue.ts). Behind a bare Function URL those headers are
  // client-spoofable, so unless TRUSTED_EDGE=true we resolve the scheme/IP from
  // the AWS-attested request context instead (`trustEdge: false`) — DEPLOY-INFRA-03.
  forwardedProtoHeader: awsForwardedProto({ trustEdge: TRUSTED_EDGE }),
  clientIp: awsClientIp({ trustEdge: TRUSTED_EDGE }),
  maxBodyBytes: 1_048_576,
  protocolContentType: 'application/json',
}

// Fail fast at cold start if the config doesn't satisfy the operations' needs.
validateConfig(OPERATIONS, config)

// --- the app -----------------------------------------------------------------
const app = new Hono<SecurityEnv>()

// Liveness bypasses the pipeline (registered first).
app.get('/healthz', healthHandler())

// The canonical security pipeline, then the routes. `handle()` feeds each phase
// the decoded request body, so the S6 verifier's `readRawBody(c)` sees the bytes
// the S2S client signed (ARCH-08).
app.use('*', ...createSecurityPipeline(OPERATIONS, config))

// A trivial protected echo route standing in for the generated router. A signed
// POST exercises the raw-body + HMAC verify path; the verifier (S6) has already
// hashed the raw body before this runs.
app.post('/orders', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  return c.json({ ok: true, principal: c.get('principal')?.id ?? null, echo: body })
})

export const handler = handle(app)
