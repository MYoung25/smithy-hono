/**
 * The resolved answers that fully determine a scaffold, plus the pure helpers that
 * validate/derive them. Everything here is I/O-free so it is unit-testable and can
 * be reused by both the interactive prompt flow and the non-interactive flag path.
 */

/** Where the generated app deploys — each target installs a different deploy CLI + entry. */
export type Target = 'cloudflare' | 'node' | 'aws'

/** Whether the app ships a same-origin React SPA (`fullstack`) or is a bare API. */
export type Frontend = 'fullstack' | 'api-only'

/** Auth flavor: `none` = anonymous CRUD demo; `oidc` = security-core + OIDC sessions. */
export type Auth = 'none' | 'oidc'

/**
 * Which CI/CD pipeline templates to emit. `github` → `.github/workflows`, `gitlab`
 * → `.gitlab-ci.yml`, `both` → both, `none` → no pipeline. Each shipped pipeline
 * runs the full build/test gate on push+PR and a keyless deploy on push to `main`.
 */
export type Ci = 'github' | 'gitlab' | 'both' | 'none'

export const TARGETS: readonly Target[] = ['cloudflare', 'node', 'aws']
export const FRONTENDS: readonly Frontend[] = ['fullstack', 'api-only']
export const AUTHS: readonly Auth[] = ['none', 'oidc']
export const CIS: readonly Ci[] = ['github', 'gitlab', 'both', 'none']

/** The concrete CI providers a `Ci` choice expands to (empty for `none`). */
export function ciProviders(ci: Ci): ('github' | 'gitlab')[] {
  switch (ci) {
    case 'github':
      return ['github']
    case 'gitlab':
      return ['gitlab']
    case 'both':
      return ['github', 'gitlab']
    case 'none':
      return []
  }
}

/** The fully-resolved scaffold options (post-prompt / post-flags). */
export interface ScaffoldOptions {
  /** Project directory name + npm `name` (a valid npm package name). */
  appName: string
  target: Target
  frontend: Frontend
  auth: Auth
  ci: Ci
}

/**
 * Pinned versions the generated project depends on. Kept in one place so a release
 * bump touches a single constant. `sh` is the `@smithy-hono/*` npm + Maven line
 * (they release together); `smithyGradlePlugin` is the Smithy Gradle base plugin.
 */
export const VERSIONS = {
  /** `@smithy-hono/*` npm packages AND `com.smithy-hono:smithy-hono` Maven jar. */
  sh: '0.2.5',
  /** `software.amazon.smithy.gradle.smithy-base` Gradle plugin. */
  smithyGradlePlugin: '1.2.0',
} as const

/**
 * npm package-name grammar (a practical subset): lowercase, may be scoped, dots /
 * hyphens / underscores allowed in the (unscoped) name part, 1–214 chars, no leading
 * dot/underscore. This is also used as the project directory name, so it must be a
 * safe path segment — the scoped form is intentionally NOT accepted as a dir name.
 */
const UNSCOPED_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,213}$/

/** True iff `name` is a valid, filesystem-safe project/package name (unscoped). */
export function isValidAppName(name: string): boolean {
  if (!UNSCOPED_NAME_RE.test(name)) return false
  // Reserve names that would clobber path traversal or npm-reserved words.
  if (name === '.' || name === '..' || name === 'node_modules') return false
  return true
}

/**
 * Derive a Smithy identifier stem from an app name: strip non-alphanumerics and
 * upper-camel-case the remaining words. `my-todo-app` → `MyTodoApp`. Falls back to
 * `App` when the name has no alphanumeric content. Used for the generated service
 * shape name and namespace segment so a scaffold has stable, valid Smithy ids.
 */
export function toPascalCase(name: string): string {
  const words = name.split(/[^a-z0-9]+/i).filter(Boolean)
  if (words.length === 0) return 'App'
  const pascal = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('')
  // A Smithy identifier must start with a letter; prefix if it starts with a digit.
  return /^[a-z]/i.test(pascal) ? pascal : `App${pascal}`
}

/** Lowercase, hyphen-collapsed slug for resource titles / worker names. */
export function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * The durable production data store each target provisions. The local dev entry
 * always uses an in-memory store; this is what the deployed entry binds.
 */
export function productionStore(target: Target): 'd1' | 'redis' | 'dynamodb' {
  switch (target) {
    case 'cloudflare':
      return 'd1'
    case 'node':
      return 'redis'
    case 'aws':
      return 'dynamodb'
  }
}

/** The `@smithy-hono/deploy-*` package + its `deploy` bin for a target. */
export function deployPackage(target: Target): { pkg: string; bin: string } {
  switch (target) {
    case 'cloudflare':
      return { pkg: '@smithy-hono/deploy-cf', bin: 'smithy-hono-deploy' }
    case 'node':
      return { pkg: '@smithy-hono/deploy-node', bin: 'smithy-hono-deploy-node' }
    case 'aws':
      return { pkg: '@smithy-hono/deploy-aws', bin: 'smithy-hono-deploy-aws' }
  }
}

/** The `@smithy-hono/adapter-*` package that backs the durable store for a target. */
export function adapterPackage(target: Target): string {
  switch (target) {
    case 'cloudflare':
      return '@smithy-hono/adapter-cf'
    case 'node':
      return '@smithy-hono/adapter-node'
    case 'aws':
      return '@smithy-hono/adapter-aws'
  }
}

/** Normalize / validate a partially-specified options object; throws on bad input. */
export function resolveOptions(opts: Partial<ScaffoldOptions>): ScaffoldOptions {
  const appName = opts.appName ?? ''
  if (!isValidAppName(appName)) {
    throw new Error(
      `invalid project name "${appName}" — use lowercase letters, digits, '-', '_' or '.', ` +
        `starting with a letter or digit (a valid npm package + directory name).`,
    )
  }
  const target = opts.target ?? 'cloudflare'
  if (!TARGETS.includes(target)) throw new Error(`unknown target "${target}"`)
  const frontend = opts.frontend ?? 'fullstack'
  if (!FRONTENDS.includes(frontend)) throw new Error(`unknown frontend "${frontend}"`)
  const auth = opts.auth ?? 'none'
  if (!AUTHS.includes(auth)) throw new Error(`unknown auth "${auth}"`)
  const ci = opts.ci ?? 'github'
  if (!CIS.includes(ci)) throw new Error(`unknown ci "${ci}"`)
  return { appName, target, frontend, auth, ci }
}
