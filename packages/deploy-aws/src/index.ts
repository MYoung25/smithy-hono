/**
 * `@smithy-hono/deploy-aws` — config-driven one-command AWS deploy for
 * smithy-hono apps. Provisions a SAME-ORIGIN edge tier: CloudFront in front of
 * an S3 SPA origin, with `/api/*` routed to a Lambda API origin, plus a DynamoDB
 * DataStore table and Secrets Manager secrets.
 *
 * Library surface (importable from a consumer's `smithy-aws-deploy.config.mjs`):
 *   - {@link defineAwsDeployConfig} + the config types,
 *   - {@link apiPrefixOf} and the pure render helpers (also used by the CLI + CDK app),
 *   - {@link materializeSecret} secret-encoding helpers.
 *
 * The CLI entry is `smithy-hono-deploy-aws` (src/bin/deploy.ts). The CDK app the
 * CLI drives ships as source under `cdk/` (see cdk/app.ts, cdk/stack.ts).
 */
export {
  defineAwsDeployConfig,
  apiPrefixOf,
  type AwsDeployConfig,
  type SpaSpec,
  type SecretSpec,
  type EnvContext,
} from './config.js'

export {
  resolveTableName,
  resolveRegion,
  usesCustomDomain,
  resolveCustomDomain,
  healthProbeHost,
  computeLambdaEnv,
  buildCdkInput,
  type CdkStackInput,
  type BuildCdkInputPaths,
} from './render.js'

export { materializeSecret, base64ToHex } from './secrets.js'
