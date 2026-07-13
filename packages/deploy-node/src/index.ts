/**
 * `@smithy-hono/deploy-node` — config-driven one-command Node/Docker/Kubernetes
 * deploy for smithy-hono apps.
 *
 * Library surface (importable from a consumer's `smithy-node-deploy.config.mjs`):
 *   - {@link defineNodeDeployConfig} + the config types,
 *   - {@link renderManifests} (also used by the CLI) + the nginx/Dockerfile helpers,
 *   - {@link materializeSecret} secret generation.
 *
 * The CLI entry is `smithy-hono-deploy-node` (src/bin/deploy.ts).
 */
export {
  defineNodeDeployConfig,
  apiPrefixOf,
  type NodeDeployConfig,
  type WebSpec,
  type SecretSpec,
  type EnvContext,
} from './config.js'

export {
  renderManifests,
  renderNginxConfig,
  renderWebDockerfile,
  objectNames,
  type ManifestContext,
} from './manifests.js'

export { materializeSecret } from './secrets.js'
