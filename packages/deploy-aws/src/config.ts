/**
 * The deploy config a consuming smithy-hono project authors (typically as
 * `smithy-aws-deploy.config.mjs`, which can also be `.json`). It declares exactly
 * what the app needs — Lambda entry, UI assets, table, secrets, domain — so the
 * `smithy-hono-deploy-aws` CLI can provision + deploy a SAME-ORIGIN edge tier
 * (CloudFront → S3 SPA, with `/api/*` → a Lambda API origin) without any
 * app-specific code baked into the tool.
 *
 * The field names here are a stable contract: the scaffolder templates and the
 * CDK app (`cdk/stack.ts`) depend on them — do not rename.
 */

/**
 * A secret materialized into a Secrets Manager secret. Either auto-generated
 * (`generate`) or read from the gitignored secrets file (`from: 'secretsFile'`,
 * e.g. an IdP client secret the user supplies).
 *
 * `hmac-hex`      — random bytes, lowercase-hex encoded (HMAC key material).
 * `hmac-base64`   — random bytes, base64 (e.g. a state-cookie signing key).
 * `random-base64` — random bytes, base64 (e.g. an audit salt).
 */
export type SecretSpec =
  | { name: string; from: 'secretsFile' }
  | { name: string; generate: 'hmac-hex' | 'hmac-base64' | 'random-base64'; bytes?: number }

/** Same-origin SPA served by CloudFront from a private S3 origin. */
export interface SpaSpec {
  /** Built static-asset directory (relative to the config dir), e.g. `web/dist`. */
  dir: string
  /** Command to build the assets before deploy (run `sh -c` in the config dir). */
  buildCommand?: string
  /** API path prefix routed to the Lambda origin (SPA serves everything else). Default `/api`. */
  apiPrefix?: string
}

/** Context passed to the `env` function: the resolved domain + api prefix. */
export interface EnvContext {
  domain: string
  apiPrefix: string
}

export interface AwsDeployConfig {
  /** App name (CloudFormation stack id + base for resource names). */
  appName: string
  /** Lambda handler entry (hono/aws-lambda `handle(app)`), relative to config dir. Default `src/handler.ts`. */
  handlerEntry?: string
  /** AWS region. Falls back to CDK_DEFAULT_REGION / AWS_REGION. */
  region?: string
  /** Same-origin SPA served by CloudFront (S3 origin), with apiPrefix/* routed to the Lambda. Omit for API-only. */
  spa?: SpaSpec
  /** Custom domain for CloudFront (needs certificateArn). If unset, uses the CloudFront default domain. */
  domainName?: string
  /** ACM cert ARN (us-east-1, required by CloudFront) for domainName. */
  certificateArn?: string
  /** DynamoDB table name for the DataStore. Default `${appName}-data`. */
  tableName?: string
  /** Extra Lambda env, derived from the domain. */
  env?: (ctx: EnvContext) => Record<string, string>
  /** Secrets to generate/sync into Secrets Manager (materialized by the CLI, created by the stack). */
  secrets?: SecretSpec[]
  /**
   * Path (relative to the config dir) to a gitignored JSON file holding values
   * for `{ from: 'secretsFile' }` secrets, keyed by secret name. Default
   * `deploy.secrets.json`.
   */
  secretsFile?: string
}

/** Identity helper giving editor types + validation when authoring the config. */
export function defineAwsDeployConfig(c: AwsDeployConfig): AwsDeployConfig {
  return c
}

/** Resolve the effective API prefix (default `/api`). */
export function apiPrefixOf(c: AwsDeployConfig): string {
  return c.spa?.apiPrefix ?? '/api'
}
