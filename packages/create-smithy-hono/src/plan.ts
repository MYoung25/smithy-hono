/**
 * Pure planning: turn resolved {@link ScaffoldOptions} into (a) the ordered list of
 * template layers to overlay and (b) the token→value substitution map. No I/O here
 * so the whole mapping is unit-tested without touching the filesystem.
 *
 * Layer model (later layers override earlier ones, package.json fragments deep-merge):
 *   base                    — gradle wiring, root tsconfig, gitignore, shared scripts
 *   app-<auth>              — the backend: model, createApp, dev entry, tests, deps
 *   ui-<auth>               — the React SPA (only when frontend === 'fullstack')
 *   deploy-<target>-<auth>  — deploy entry + config + platform files + deploy deps
 *   ci-<provider>-<target>  — build/test + keyless-deploy pipeline (per ci choice)
 *
 * The CI layers are keyed by provider (github/gitlab) and target (the deploy
 * credentials + steps differ per platform) but NOT by auth or frontend: they stay
 * agnostic by running `npm run build:ui --if-present` (a no-op for api-only) and
 * only materializing `deploy.secrets.json` when the OIDC secret is present. So a
 * single pair of files covers every auth/frontend combination for that target.
 *
 * The deploy layer is keyed by BOTH target and auth because the entry, deploy
 * config, bindings, and migrations all differ across that pair (e.g. a Cloudflare
 * crud app binds only D1, while the OIDC app also binds KV + a security Durable
 * Object and carries OIDC secrets).
 */
import {
  adapterPackage,
  ciProviders,
  deployPackage,
  productionStore,
  toSlug,
  VERSIONS,
  type ScaffoldOptions,
  type Target,
  type Frontend,
} from './options.js'
import type { Substitutions } from './render.js'

export interface ScaffoldPlan {
  /** Template directory names to overlay, in application order. */
  layers: string[]
  /** Token substitutions applied to every rendered text file. */
  subs: Substitutions
}

/**
 * The deploy-config snippet that turns on same-origin static-asset serving. Its
 * shape is target-specific (each deploy CLI has its own config schema) and it is
 * empty for an API-only app. Injected into the target's `smithy-*-deploy.config.mjs`
 * at the `{{ASSETS_CONFIG}}` token.
 */
export function assetsConfigSnippet(target: Target, frontend: Frontend): string {
  if (frontend !== 'fullstack') return ''
  const build = "buildCommand: 'npm run build:ui'"
  switch (target) {
    case 'cloudflare':
      return [
        '  assets: {',
        "    dir: 'ui/dist',",
        `    ${build},`,
        "    apiPrefix: '/api',",
        '    spa: true,',
        '  },',
      ].join('\n')
    case 'node':
      return [
        '  web: {',
        "    dir: 'ui/dist',",
        `    ${build},`,
        "    apiPrefix: '/api',",
        '  },',
      ].join('\n')
    case 'aws':
      return [
        '  spa: {',
        "    dir: 'ui/dist',",
        `    ${build},`,
        "    apiPrefix: '/api',",
        '  },',
      ].join('\n')
  }
}

/** Build the full plan (layers + substitutions) for a set of resolved options. */
export function planScaffold(opts: ScaffoldOptions): ScaffoldPlan {
  const { appName, target, frontend, auth, ci } = opts
  const layers = [
    'base',
    `app-${auth}`,
    ...(frontend === 'fullstack' ? [`ui-${auth}`] : []),
    `deploy-${target}-${auth}`,
    ...ciProviders(ci).map((provider) => `ci-${provider}-${target}`),
  ]

  const { pkg: deployPkg, bin: deployBin } = deployPackage(target)

  const subs: Substitutions = {
    APP_NAME: appName,
    APP_SLUG: toSlug(appName) || 'app',
    SH_VERSION: VERSIONS.sh,
    SMITHY_GRADLE_VERSION: VERSIONS.smithyGradlePlugin,
    ADAPTER_PKG: adapterPackage(target),
    DEPLOY_PKG: deployPkg,
    DEPLOY_BIN: deployBin,
    PROD_STORE: productionStore(target),
    ASSETS_CONFIG: assetsConfigSnippet(target, frontend),
  }

  return { layers, subs }
}
