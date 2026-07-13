/**
 * `@smithy-hono/deploy-cf` — config-driven one-command Cloudflare deploy for
 * smithy-hono apps.
 *
 * Library surface (importable from a consumer's `smithy-deploy.config.mjs`):
 *   - {@link defineDeployConfig} + the config types,
 *   - {@link renderWrangler} (also used by the CLI),
 *   - {@link materializeSecret} secret-encoding helpers.
 *
 * The CLI entry is `smithy-hono-deploy` (src/bin/deploy.ts).
 */
export {
  defineDeployConfig,
  apiPrefixOf,
  deriveDurableObjects,
  realtimeHubBinding,
  REALTIME_HUB_BINDING,
  REALTIME_HUB_CLASS,
  REALTIME_HUB_MIGRATION_TAG,
  type DeployConfig,
  type BindingsSpec,
  type KvBindingSpec,
  type DurableObjectSpec,
  type D1BindingSpec,
  type SecretSpec,
  type AssetsSpec,
  type OidcFacts,
  type VarsContext,
} from './config.js'

export {
  renderWrangler,
  orderMigrationTags,
  migrationGeneration,
  type RenderContext,
} from './wrangler.js'

export { materializeSecret, base64ToHex } from './secrets.js'
