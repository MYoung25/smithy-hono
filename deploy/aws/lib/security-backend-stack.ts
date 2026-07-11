/**
 * OPS-02 (AWS) — Infrastructure-as-code for the `@smithy-hono/adapter-aws`
 * backends, as an AWS CDK (TypeScript) stack.
 *
 * Provisions exactly what the adapter reads, nothing it doesn't:
 *
 *   1. ONE DynamoDB table backing all three stores (session / rate-limit /
 *      nonce — keys are namespaced `sess:` / `rl:` / `nonce:` by the stores, so
 *      a single physical table suffices). Schema is dictated by the adapter:
 *        - Partition key  `pk`  (String)  — `PK_ATTR`  in port.ts:74.
 *        - TTL attribute  `ttl` (Number)  — `TTL_ATTR` in port.ts:72; epoch
 *          SECONDS (dynamoPort.ts:21). DynamoDB TTL enabled on it.
 *        - Billing PAY_PER_REQUEST (on-demand) per the gap acceptance criteria.
 *      The `version` attribute (port.ts:70) is a plain item attribute managed by
 *      the port at write time — NOT a key — so it needs no table-level schema.
 *
 *   2. Secrets Manager secret(s) for the HMAC signing key(s) the
 *      `SecretsManagerSecretProvider` resolves (secrets.ts). The secret STRING
 *      is the raw HMAC key encoded as base64 (secrets.ts:16-17, README §"Key
 *      material encoding"). The secret *name* is the `secretId` the adapter is
 *      told to fetch via `keyIdToSecretId` — here `prod/sig/<keyId>` (matching
 *      the README wiring example, adapter-aws/README.md:123). We create them
 *      with a CDK-generated placeholder; operators overwrite with the real
 *      base64 key out-of-band (see deploy/aws/README.md "Seeding secrets").
 *
 *   3. A Lambda (the sample handler in ../src/handler.ts) with least-privilege
 *      IAM: read/write the table, read the signing secret(s). The table name and
 *      the keyId→secretId mapping are passed to the Lambda as environment
 *      variables the handler reads (SECURITY_TABLE / SIGNING_KEY_IDS /
 *      SIGNING_SECRET_PREFIX / SIGNING_CLIENT_KEY) — see handler.ts.
 *
 * No KMS CMK / VPC / API Gateway is provisioned here: the gap asks only for the
 * table, the secrets, and IAM for a Lambda to access them. A Function URL is
 * attached for a smoke invoke; it defaults to AWS_IAM auth (SigV4-required, not
 * public) — opt down to public NONE only via `-c publicFunctionUrl=true`. Front
 * it with API Gateway / ALB for a real trusted edge; the handler otherwise reads
 * the client IP / scheme from the AWS request context, not the spoofable
 * X-Forwarded-* headers (TRUSTED_EDGE — see README and src/handler.ts).
 */

import { Stack, StackProps, RemovalPolicy, Duration, CfnOutput } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

// ESM has no `__dirname`; derive it from this module's URL.
const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface SecurityBackendStackProps extends StackProps {
  /**
   * The signing keyIds to provision a secret for (newest first). Each becomes a
   * Secrets Manager secret named `<secretPrefix>/<keyId>`. Provide both the
   * current and the previous keyId during a rotation window (SIGN-05).
   * Default: a single demo keyId.
   */
  readonly signingKeyIds?: string[]
  /**
   * Secret-name prefix the handler builds `secretId`s from. Must match the
   * handler's `SIGNING_SECRET_PREFIX`. Default `prod/sig` (README example).
   */
  readonly secretPrefix?: string
  /** The S2S client id whose requests sign with the current (first) keyId. Default `svc-orders`. */
  readonly signingClientId?: string
}

export class SecurityBackendStack extends Stack {
  constructor(scope: Construct, id: string, props: SecurityBackendStackProps = {}) {
    super(scope, id, props)

    const signingKeyIds = props.signingKeyIds ?? ['k-demo-1']
    const secretPrefix = props.secretPrefix ?? 'prod/sig'
    const signingClientId = props.signingClientId ?? 'svc-orders'

    // --- 1. The DynamoDB table (one table, three stores) ---------------------
    // Attribute names are dictated by the adapter port (cite: packages/adapter-
    // aws/src/port.ts:72-74). `pk` String partition key; `ttl` Number TTL attr.
    const table = new dynamodb.Table(this, 'SecurityTable', {
      // Partition key `pk` (String) — PK_ATTR, port.ts:74; the only key attr,
      // no sort key (the stores namespace within `pk`).
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      // TTL on `ttl` (Number, epoch seconds) — TTL_ATTR, port.ts:72 /
      // dynamoPort.ts:21. DynamoDB sweeps eventually; the stores still do an
      // in-code expiry check (README §"Required DynamoDB table schema").
      timeToLiveAttribute: 'ttl',
      // On-demand / PAY_PER_REQUEST per the gap acceptance criteria.
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Strong consistency is the adapter's concern (ConsistentRead +
      // conditional writes, dynamoPort.ts); the table needs no special mode.
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Demo default: destroy with the stack. Set RETAIN for production data.
      removalPolicy: RemovalPolicy.DESTROY,
    })

    // --- 2. Secrets Manager secret(s) for the HMAC signing key(s) ------------
    // One secret per keyId, named `<secretPrefix>/<keyId>` so it matches the
    // `keyIdToSecretId` the handler builds (secrets.ts:84, README:123). The
    // value is a base64-encoded raw HMAC key (secrets.ts:16-17); CDK seeds a
    // placeholder, operators overwrite it (see README "Seeding secrets").
    const signingSecrets = signingKeyIds.map(
      (keyId) =>
        new secretsmanager.Secret(this, `SigningKey-${keyId}`, {
          secretName: `${secretPrefix}/${keyId}`,
          description: `HMAC signing key '${keyId}' (base64 raw bytes) for @smithy-hono/adapter-aws`,
          // A random base64-ALPHABET placeholder — the SAME encoding the adapter
          // decodes (secrets.ts:41-47 base64ToArrayBuffer → importKey 'raw').
          // `excludePunctuation` keeps the alphabet to `A-Z a-z 0-9`, all of which
          // are valid base64 characters, so `atob` does not throw (DEPLOY-INFRA-07).
          // (A 44-char string over this alphabet decodes to ~33 bytes, not exactly
          // 32 — harmless, as HMAC accepts any-length keys.) This makes the stack
          // deployable without a real key; rotate to the real 32-byte base64 key
          // before signing real traffic (see README "Seeding secrets").
          generateSecretString: {
            passwordLength: 44, // base64-alphabet chars (placeholder, not exactly 32 bytes)
            excludePunctuation: true, // keep to A-Z a-z 0-9 → valid base64 alphabet
            includeSpace: false,
          },
          removalPolicy: RemovalPolicy.DESTROY,
        }),
    )

    // --- 3. The sample Lambda + least-privilege IAM --------------------------
    const fn = new NodejsFunction(this, 'SecurityHandler', {
      entry: path.join(__dirname, '..', 'src', 'handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(15),
      environment: {
        // The table name the handler passes to `createDynamoTablePort(client,
        // tableName)` (dynamoPort.ts:71). Read as `SECURITY_TABLE` (handler.ts).
        SECURITY_TABLE: table.tableName,
        // The handler rebuilds `keyIdToSecretId` from these: for each keyId it
        // forms `<SIGNING_SECRET_PREFIX>/<keyId>` — the secret names created
        // above — and maps `SIGNING_CLIENT_KEY`'s client → the FIRST keyId
        // (current) for `clientToCurrentKeyId` (secrets.ts:34-35,84).
        SIGNING_KEY_IDS: signingKeyIds.join(','),
        SIGNING_SECRET_PREFIX: secretPrefix,
        SIGNING_CLIENT_KEY: `${signingClientId}=${signingKeyIds[0]}`,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        format: OutputFormat.ESM,
        target: 'node22',
        // The adapter is Web-standard-only (ARCH-01); the @aws-sdk/* clients are
        // present in the Lambda runtime, so leave them external (not bundled).
        externalModules: [
          '@aws-sdk/client-dynamodb',
          '@aws-sdk/lib-dynamodb',
          '@aws-sdk/client-secrets-manager',
        ],
      },
    })

    // Least privilege: the stores need Get/Put/Update/Delete on the one table
    // (dynamoPort.ts uses Get/Put/Delete; Update is granted for completeness).
    table.grantReadWriteData(fn)
    // The provider only READS the signing secret(s) (secrets.ts getSecretString).
    for (const secret of signingSecrets) secret.grantRead(fn)

    // A Function URL for a no-frills smoke invoke. SECURE-BY-DEFAULT
    // (DEPLOY-INFRA-03): default to AWS_IAM so the endpoint requires SigV4 and is
    // NOT public. Opt down to public NONE only for a throwaway smoke test via
    // `-c publicFunctionUrl=true`. Either way a bare Function URL is NOT a trusted
    // edge, so the handler resolves the client IP / scheme from the AWS request
    // context unless TRUSTED_EDGE=true (it ignores the spoofable X-Forwarded-*);
    // front with API Gateway / ALB for a real trusted edge.
    const publicFunctionUrl = this.node.tryGetContext('publicFunctionUrl') === 'true'
    const url = fn.addFunctionUrl({
      authType: publicFunctionUrl
        ? lambda.FunctionUrlAuthType.NONE
        : lambda.FunctionUrlAuthType.AWS_IAM,
    })

    // --- Outputs -------------------------------------------------------------
    new CfnOutput(this, 'TableName', { value: table.tableName })
    new CfnOutput(this, 'FunctionName', { value: fn.functionName })
    new CfnOutput(this, 'FunctionUrl', { value: url.url })
    new CfnOutput(this, 'SigningSecretNames', {
      value: signingSecrets.map((s) => s.secretName).join(','),
    })
  }
}
