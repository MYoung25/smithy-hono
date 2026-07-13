/**
 * `SmithyHonoAppStack` — the greenfield SAME-ORIGIN edge tier the
 * `smithy-hono-deploy-aws` CLI drives.
 *
 * Provisions:
 *   1. ONE DynamoDB table (the DataStore): partition key `pk` (String), TTL on
 *      `ttl` (Number, epoch seconds), PAY_PER_REQUEST — the schema the
 *      `@smithy-hono/adapter-aws` Dynamo port expects.
 *   2. Secrets Manager secret(s) for the materialized secret values the CLI
 *      passes in (each granted read to the Lambda; its ARN is injected as
 *      `SECRET_ARN_<NAME>`).
 *   3. A `NodejsFunction` (the app's `hono/aws-lambda` handler) on NODEJS_22_X,
 *      esbuild-bundled to ESM, with the DataStore + secret grants and a Function
 *      URL used as the API origin.
 *   4. When a SPA is configured: a PRIVATE S3 bucket (the SPA origin) + a
 *      CloudFront distribution whose DEFAULT behavior serves the SPA (with a
 *      403/404 → `/index.html` rewrite for client-side routing) and whose
 *      `${apiPrefix}/*` behavior forwards to the Lambda Function URL origin —
 *      i.e. UI + API same-origin. An optional custom domain
 *      (`domainName` + `certificateArn`, cert in us-east-1) is attached.
 *
 * Outputs the CloudFront domain (when a SPA is present), the Function URL, and
 * the table name.
 *
 * NOTE: the private `deploy/aws` directory in this repo is an OLDER,
 * security-backend-only CDK app (table + secrets + one sample Function-URL
 * Lambda); this stack is the greenfield same-origin edge tier for the published
 * CLI and is unrelated to it.
 *
 * `StackInput` mirrors `CdkStackInput` in `src/render.ts` — the two sides
 * communicate over JSON, so keep them structurally in sync.
 */
import * as path from 'node:path'

import { Stack, StackProps, RemovalPolicy, Duration, CfnOutput, SecretValue } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'

/** The fully-resolved, JSON input the CLI hands the CDK app (mirrors CdkStackInput). */
export interface StackInput {
  appName: string
  handlerEntry: string
  region?: string
  tableName: string
  apiPrefix: string
  domainName?: string
  certificateArn?: string
  spa?: { dir: string }
  env: Record<string, string>
  secrets: Array<{ name: string; value: string }>
}

export interface SmithyHonoAppStackProps extends StackProps {
  readonly input: StackInput
}

/** Sanitize a secret name into a valid env-var key: `SECRET_ARN_<UPPER_SNAKE>`. */
function secretEnvKey(name: string): string {
  return 'SECRET_ARN_' + name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
}

/** `/api` → `api/*`, `api` → `api/*` — the CloudFront path-pattern for the API behavior. */
function apiPathPattern(apiPrefix: string): string {
  return `${apiPrefix.replace(/^\/+/, '').replace(/\/+$/, '')}/*`
}

export class SmithyHonoAppStack extends Stack {
  constructor(scope: Construct, id: string, props: SmithyHonoAppStackProps) {
    super(scope, id, props)
    const { input } = props

    // --- 1. DynamoDB DataStore table -----------------------------------------
    const table = new dynamodb.Table(this, 'DataTable', {
      tableName: input.tableName,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // `pointInTimeRecovery` (not `pointInTimeRecoverySpecification`, which only
      // exists in aws-cdk-lib >= ~2.171) so this typechecks/works at the declared
      // `^2.150.0` floor as well as on newer versions.
      pointInTimeRecovery: true,
      // Application DATA — retain on stack delete so a teardown doesn't drop it.
      removalPolicy: RemovalPolicy.RETAIN,
    })

    // --- 2. Secrets Manager secret(s) ----------------------------------------
    // The CLI materialized the values (generated or from the secrets file) and
    // conveyed them via a temp FILE (never argv). CDK renders each value into the
    // CloudFormation template; treat the synthesized template as sensitive.
    const secretArnEnv: Record<string, string> = {}
    const secrets = input.secrets.map((s) => {
      const secret = new secretsmanager.Secret(this, `Secret-${s.name}`, {
        secretName: `${input.appName}/${s.name}`,
        secretStringValue: SecretValue.unsafePlainText(s.value),
        removalPolicy: RemovalPolicy.DESTROY,
      })
      secretArnEnv[secretEnvKey(s.name)] = secret.secretArn
      return secret
    })

    // --- 3. The Lambda API handler + least-privilege IAM ---------------------
    const fn = new NodejsFunction(this, 'ApiHandler', {
      entry: input.handlerEntry,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(15),
      environment: {
        ...input.env,
        ...secretArnEnv,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        format: OutputFormat.ESM,
        target: 'node22',
      },
    })
    table.grantReadWriteData(fn)
    for (const secret of secrets) secret.grantRead(fn)

    // The API origin. Public (NONE): CloudFront (when a SPA is configured) is the
    // trusted edge in front; for an API-only deploy the Function URL IS the
    // endpoint. Front with an ALB / IAM-authed OAC for a hardened edge.
    const fnUrl = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE })

    // --- 4. Same-origin CloudFront edge (only when a SPA is configured) ------
    let distributionDomain: string | undefined
    if (input.spa) {
      const bucket = new s3.Bucket(this, 'SpaBucket', {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        removalPolicy: RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
      })

      const certificate =
        input.domainName && input.certificateArn
          ? acm.Certificate.fromCertificateArn(this, 'Cert', input.certificateArn)
          : undefined

      const distribution = new cloudfront.Distribution(this, 'Distribution', {
        defaultRootObject: 'index.html',
        defaultBehavior: {
          origin: new origins.S3Origin(bucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        additionalBehaviors: {
          // `${apiPrefix}/*` → the Lambda Function URL origin (same origin as the SPA).
          [apiPathPattern(input.apiPrefix)]: {
            origin: new origins.FunctionUrlOrigin(fnUrl),
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
            cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
            // Forward everything except Host (Function URLs reject a foreign Host header).
            originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          },
        },
        // SPA routing: serve index.html for S3 misses (client-side routes).
        errorResponses: [
          { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
          { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
        ],
        domainNames: certificate && input.domainName ? [input.domainName] : undefined,
        certificate,
      })

      // Upload the built SPA assets and invalidate on each deploy.
      new s3deploy.BucketDeployment(this, 'SpaDeployment', {
        sources: [s3deploy.Source.asset(path.resolve(input.spa.dir))],
        destinationBucket: bucket,
        distribution,
        distributionPaths: ['/*'],
      })

      distributionDomain = distribution.distributionDomainName
      new CfnOutput(this, 'DistributionDomain', { value: distribution.distributionDomainName })
    }

    // --- Outputs -------------------------------------------------------------
    new CfnOutput(this, 'TableName', { value: table.tableName })
    new CfnOutput(this, 'FunctionUrl', { value: fnUrl.url })
    if (distributionDomain) {
      new CfnOutput(this, 'CloudFrontDomain', { value: distributionDomain })
    }
  }
}
