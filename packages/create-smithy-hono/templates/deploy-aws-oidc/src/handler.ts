/**
 * AWS Lambda entry (hono/aws-lambda) for the SECURE service: all seven security
 * layers + the OIDC cookie-session flow, served under `/api`. CloudFront
 * (provisioned by `@smithy-hono/deploy-aws`) routes `/api/*` to this Lambda and
 * everything else to the S3 SPA origin, same-origin.
 *
 * Backends (all from env injected by the CDK stack):
 *   - DynamoDB (one table) → session + nonce security stores, via the adapter's
 *     `createDynamoTablePort` over a `DynamoDBDocumentClient`.
 *   - Secrets Manager → the demo S2S HMAC key + the OIDC state secret / audit salt /
 *     confidential client secret, fetched by their CDK-injected `SECRET_ARN_<NAME>`.
 *
 * The adapter never imports the AWS SDK (ARCH-01): it speaks to DynamoDB through a
 * structural `DynamoSendLike` mapping the port's tagged command inputs onto the
 * real DocumentClient commands, supplied here.
 *
 * Env vars (set by the deploy CLI / CDK stack):
 *   TABLE                  DynamoDB table name                  (default {{APP_SLUG}}-data)
 *   OIDC_ISSUER            discovery issuer                     (required)
 *   OIDC_CLIENT_ID         registered client id + audience      (required)
 *   OIDC_AUTHORIZE_URL     IdP authorize endpoint               (required)
 *   OIDC_TOKEN_URL         IdP token endpoint                   (required)
 *   OIDC_REDIRECT_URI      https://<domain>/api/auth/callback   (required)
 *   ALLOWED_ORIGINS        comma-separated CORS origins         (required)
 *   AUDIT_SALT             (from Secrets Manager via SECRET_ARN_AUDIT_SALT)
 *   OIDC_STATE_SECRET      (from Secrets Manager via SECRET_ARN_OIDC_STATE_SECRET)
 *   OIDC_CLIENT_SECRET     (optional; SECRET_ARN_OIDC_CLIENT_SECRET)
 *   SIGNING_KEY_IMPORTER_V1  (S2S HMAC key; SECRET_ARN_SIGNING_KEY_IMPORTER_V1)
 *   TRUSTED_EDGE           "true" when CloudFront fronts the Lambda (set by config)
 */

import { handle } from 'hono/aws-lambda'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb'
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import {
  createDynamoTablePort,
  DynamoSessionStore,
  DynamoNonceStore,
  SecretsManagerSecretProvider,
  awsForwardedProto,
  awsClientIp,
  createConsoleLogger,
  createConsoleAuditSink,
  type DynamoSendLike,
  type SecretsSourceLike,
} from '@smithy-hono/adapter-aws'
import { createOidcVerifier } from '@smithy-hono/security-core'
import { createApp } from './createApp'
import { createMemoryNotesStore } from './notesStore'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var ${name}`)
  return v
}

const TABLE = process.env.TABLE ?? '{{APP_SLUG}}-data'
// CloudFront fronts the Lambda, so its X-Forwarded-* are trusted (set by config).
const TRUSTED_EDGE = process.env.TRUSTED_EDGE === 'true'
const IMPORTER_CLIENT_ID = process.env.IMPORTER_CLIENT_ID ?? 'importer'
const IMPORTER_KEY_ID = process.env.IMPORTER_KEY_ID ?? 'importer-v1'

// ── DynamoDB port ──────────────────────────────────────────────────────────────
// The adapter never imports the SDK (ARCH-01): satisfy `DynamoSendLike` by
// translating its tagged plain command input into the real DocumentClient command.
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const COMMANDS = {
  Put: PutCommand,
  Get: GetCommand,
  Update: UpdateCommand,
  Delete: DeleteCommand,
  Query: QueryCommand,
} as const
const sendLike: DynamoSendLike = {
  send(command) {
    const { __command, ...input } = command as { __command: keyof typeof COMMANDS } & Record<
      string,
      unknown
    >
    const Command = COMMANDS[__command]
    return doc.send(new Command(input as never)) as Promise<
      { Item?: Record<string, unknown> } & Record<string, unknown>
    >
  },
}
const port = createDynamoTablePort(sendLike, TABLE)

// ── Secrets Manager ─────────────────────────────────────────────────────────────
// Each deploy secret is materialized into a Secrets Manager secret whose ARN the
// CDK stack injects as `SECRET_ARN_<NAME>`. Fetch a secret's value by its logical
// name via that ARN.
const sm = new SecretsManagerClient({})
async function getSecret(name: string): Promise<string | null> {
  const arn = process.env[`SECRET_ARN_${name}`]
  if (!arn) return null
  const out = await sm.send(new GetSecretValueCommand({ SecretId: arn }))
  return out.SecretString ?? null
}

// The S2S HMAC key provider reads base64 material by keyId → secret ARN.
const secretsSource: SecretsSourceLike = {
  async getSecretString(secretId: string) {
    const out = await sm.send(new GetSecretValueCommand({ SecretId: secretId }))
    return out.SecretString ?? null
  },
}
const signingKeyArn = requireEnv('SECRET_ARN_SIGNING_KEY_IMPORTER_V1')
const secrets = new SecretsManagerSecretProvider(secretsSource, {
  keyIdToSecretId: { [IMPORTER_KEY_ID]: signingKeyArn },
  clientToCurrentKeyId: { [IMPORTER_CLIENT_ID]: IMPORTER_KEY_ID },
})

// ── Plain secrets + OIDC verifier (built once at cold start) ────────────────────
const oidcStateSecret = await getSecret('OIDC_STATE_SECRET')
if (!oidcStateSecret) throw new Error('Missing secret OIDC_STATE_SECRET (SECRET_ARN_OIDC_STATE_SECRET)')
const auditSalt = (await getSecret('AUDIT_SALT')) ?? 'demo-salt-replace-in-production'
const oidcClientSecret = (await getSecret('OIDC_CLIENT_SECRET')) ?? undefined

const oidcVerifier = await createOidcVerifier({
  issuer: requireEnv('OIDC_ISSUER'),
  audience: requireEnv('OIDC_CLIENT_ID'),
})

// ── The app ─────────────────────────────────────────────────────────────────────
const { app } = createApp({
  // ⚠️ DEMO / EPHEMERAL notes store (per-invocation `Map`): notes writes do not
  // persist across Lambda instances. The SECURITY stores (session + nonce on
  // DynamoDB) ARE durable. For production, back notes with a durable adapter store.
  notesStore: createMemoryNotesStore(),
  stores: {
    session: new DynamoSessionStore(port),
    nonce: new DynamoNonceStore(port),
    secrets,
  },
  oidcVerifier,
  logger: createConsoleLogger(),
  audit: createConsoleAuditSink({ base: { service: '{{APP_SLUG}}' } }),
  auditSalt,
  oidc: {
    issuer: requireEnv('OIDC_ISSUER'),
    clientId: requireEnv('OIDC_CLIENT_ID'),
    clientSecret: oidcClientSecret,
    audience: requireEnv('OIDC_CLIENT_ID'),
    redirectUri: requireEnv('OIDC_REDIRECT_URI'),
    authorizationEndpoint: requireEnv('OIDC_AUTHORIZE_URL'),
    tokenEndpoint: requireEnv('OIDC_TOKEN_URL'),
  },
  oidcStateSecret,
  // AWS-edge glue: with CloudFront in front (TRUSTED_EDGE), read the normalized
  // X-Forwarded-*; otherwise resolve scheme/IP from the AWS request context.
  forwardedProtoHeader: awsForwardedProto({ trustEdge: TRUSTED_EDGE }),
  clientIp: awsClientIp({ trustEdge: TRUSTED_EDGE }),
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  basePath: '/api',
})

export const handler = handle(app)
