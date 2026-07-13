/**
 * PURE helpers shared by the CLI (`src/bin/deploy.ts`) and the CDK app
 * (`cdk/app.ts` + `cdk/stack.ts`). This module deliberately imports NO
 * `aws-cdk-lib` — it derives the fully-resolved, JSON-serializable stack INPUT
 * (table name, Lambda env, region, custom-domain decision, and the materialized
 * secret values) so both sides agree by construction and these functions stay
 * cheap to unit-test.
 *
 * The CLI resolves everything here (including running `config.env(ctx)`, which is
 * a function and therefore NOT itself serializable), writes the resulting
 * {@link CdkStackInput} to a temp file, and hands the file PATH to the CDK app —
 * never argv — so secret values never appear in a process listing.
 */
import { apiPrefixOf, type AwsDeployConfig, type EnvContext } from './config.js'

/** The DynamoDB DataStore table name: explicit `tableName`, else `${appName}-data`. */
export function resolveTableName(config: AwsDeployConfig): string {
  return config.tableName ?? `${config.appName}-data`
}

/**
 * Resolve the effective AWS region: explicit `config.region`, else the ambient
 * `CDK_DEFAULT_REGION`, else `AWS_REGION`, else undefined (CDK then resolves it
 * from the environment/profile at synth time). `env` is injected so this stays
 * pure/testable — the CLI passes `process.env`.
 */
export function resolveRegion(
  config: AwsDeployConfig,
  env: { CDK_DEFAULT_REGION?: string; AWS_REGION?: string },
): string | undefined {
  return config.region ?? env.CDK_DEFAULT_REGION ?? env.AWS_REGION
}

/**
 * True iff a custom CloudFront domain is fully configured — BOTH `domainName`
 * and `certificateArn` (CloudFront requires an ACM cert in us-east-1 to serve an
 * alias). When false, the distribution uses its default `*.cloudfront.net`
 * domain and {@link resolveCustomDomain} returns undefined.
 */
export function usesCustomDomain(config: AwsDeployConfig): boolean {
  return Boolean(config.domainName && config.certificateArn)
}

/** The custom domain to bind on CloudFront, or undefined to use the default domain. */
export function resolveCustomDomain(config: AwsDeployConfig): string | undefined {
  return usesCustomDomain(config) ? config.domainName : undefined
}

/**
 * The host to health-probe after deploy: the custom domain when fully wired,
 * else the CloudFront-assigned domain discovered from the CDK outputs (may be
 * undefined for an API-only deploy that produced no distribution — the caller
 * then falls back to the Function URL host).
 */
export function healthProbeHost(
  config: AwsDeployConfig,
  cloudfrontDomain: string | undefined,
): string | undefined {
  return resolveCustomDomain(config) ?? cloudfrontDomain
}

/**
 * The Lambda environment (pure subset): the DataStore `TABLE` and `API_PREFIX`,
 * overlaid by the operator's `config.env(ctx)`, plus a `SECRET_NAMES` listing
 * (comma-separated) so the handler can enumerate its secrets. The CDK stack
 * merges in the per-secret ARN env vars (`SECRET_ARN_*`) it alone knows.
 */
export function computeLambdaEnv(config: AwsDeployConfig, ctx: EnvContext): Record<string, string> {
  const env: Record<string, string> = {
    TABLE: resolveTableName(config),
    API_PREFIX: apiPrefixOf(config),
    ...(config.env?.(ctx) ?? {}),
  }
  const names = (config.secrets ?? []).map((s) => s.name)
  if (names.length > 0) env.SECRET_NAMES = names.join(',')
  return env
}

/**
 * The fully-resolved, JSON-serializable input the CDK app synthesizes from. The
 * CLI produces it via {@link buildCdkInput}; `cdk/stack.ts` mirrors this shape
 * as its `StackInput` (they MUST be kept in sync — the boundary is JSON, so it
 * is structurally typed).
 */
export interface CdkStackInput {
  appName: string
  /** ABSOLUTE path to the Lambda handler entry (the CLI resolves it against the config dir). */
  handlerEntry: string
  region?: string
  tableName: string
  apiPrefix: string
  domainName?: string
  certificateArn?: string
  /** Present only when a SPA is configured. `dir` is the ABSOLUTE built-assets dir. */
  spa?: { dir: string }
  /** Lambda env (see {@link computeLambdaEnv}); the stack adds SECRET_ARN_* on top. */
  env: Record<string, string>
  /** Materialized secret values (name → value). Conveyed via a temp FILE, never argv. */
  secrets: Array<{ name: string; value: string }>
}

/** Options the CLI supplies with already-resolved (absolute) filesystem paths. */
export interface BuildCdkInputPaths {
  /** Absolute path to the handler entry (overrides `config.handlerEntry`). */
  handlerEntry: string
  /** Absolute path to the built SPA dir (required iff `config.spa` is set). */
  spaDir?: string
}

/**
 * Assemble the {@link CdkStackInput} from the config, the resolved deploy context
 * (domain + apiPrefix), the materialized secret values, and the CLI-resolved
 * absolute paths. Pure: does no I/O and touches no CDK types.
 */
export function buildCdkInput(
  config: AwsDeployConfig,
  ctx: EnvContext,
  secretValues: Record<string, string>,
  paths: BuildCdkInputPaths,
): CdkStackInput {
  return {
    appName: config.appName,
    handlerEntry: paths.handlerEntry,
    region: config.region,
    tableName: resolveTableName(config),
    apiPrefix: apiPrefixOf(config),
    domainName: config.domainName,
    certificateArn: config.certificateArn,
    spa: config.spa ? { dir: paths.spaDir ?? config.spa.dir } : undefined,
    env: computeLambdaEnv(config, ctx),
    secrets: (config.secrets ?? []).map((s) => {
      const value = secretValues[s.name]
      if (typeof value !== 'string') {
        throw new Error(`buildCdkInput: no materialized value for secret "${s.name}"`)
      }
      return { name: s.name, value }
    }),
  }
}
