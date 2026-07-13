#!/usr/bin/env node
/**
 * `smithy-hono-deploy-node` — the one-command Node/Docker/Kubernetes deploy
 * orchestrator.
 *
 * Run from a consuming smithy-hono project directory (the config dir =
 * `process.cwd()`). Given a bare domain it: loads the deploy config, builds the API
 * container image (and — when a web front-door is configured — the SPA + nginx web
 * image), pushes them if a registry is set, syncs secrets into a per-app k8s
 * `Secret`, renders + applies the Deployment/Service/Ingress/ConfigMap manifests,
 * waits for the rollout, then probes `/healthz` and reports the live URL.
 *
 * Ordering matters: the Secret is created BEFORE `kubectl apply` (the API
 * Deployment binds it via `envFrom`, so the pod can't start ready without it), and
 * the manifests apply before `rollout status`.
 *
 * The flow is idempotent: built image tags + an "applied" marker are persisted to
 * `.smithy-deploy-node/<domainSlug>.json` so re-runs are cheap. Secret VALUES are
 * never logged and never persisted.
 *
 * Node APIs (argv, fs, child_process, fetch) are intentionally confined to this
 * CLI file; the importable library surface (config/manifests/secrets) stays pure.
 *
 * Usage:
 *   smithy-hono-deploy-node <domain> [--skip-build] [--config <path>] [--namespace <ns>] [--dry-run]
 */

import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

import { apiPrefixOf, type NodeDeployConfig } from '../config.js'
import { renderManifests, renderWebDockerfile, objectNames } from '../manifests.js'
import { materializeSecret } from '../secrets.js'

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Log a progress/step line to stderr (stdout is reserved for machine output). */
function log(msg: string): void {
  process.stderr.write(msg + '\n')
}

/** Print an error to stderr and exit with the given non-zero code. */
function fail(msg: string, code = 1): never {
  process.stderr.write('error: ' + msg + '\n')
  process.exit(code)
}

/** Await-based sleep used between health-probe attempts. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

const USAGE = `smithy-hono-deploy-node — one-command Node/Docker/Kubernetes deploy

Usage:
  smithy-hono-deploy-node <domain> [--skip-build] [--config <path>] [--namespace <ns>] [--dry-run]

Arguments:
  <domain>          Bare hostname to deploy to (e.g. app.example.com). No scheme,
                    path, whitespace or trailing dot.

Flags:
  --skip-build      Skip the SPA (web.buildCommand) build step; reuse the existing
                    built assets when building the web image.
  --config <path>   Path to the deploy config (overrides auto-discovery).
  --namespace <ns>  Kubernetes namespace to deploy into (overrides the config).
  --dry-run         Render the manifests to stdout and exit — no docker/kubectl.`

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

export interface CliArgs {
  domain: string
  skipBuild: boolean
  dryRun: boolean
  namespace: string | undefined
  configPath: string | undefined
}

/**
 * Strict DNS-hostname grammar: dot-separated labels, each 1–63 chars of
 * `[a-z0-9-]`, no leading/trailing hyphen, total ≤ 253 chars. Rejects `_`,
 * consecutive dots, scheme/path/whitespace and trailing dots. Case-insensitive.
 *
 * Intentionally stricter than "no scheme/path/whitespace": distinct forms like
 * `a_b.example.com` vs `a-b.example.com` must NOT be accepted, because the
 * state-file slug would otherwise alias them onto one another.
 */
const HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i

/** True iff `domain` is a syntactically valid bare DNS hostname (see HOSTNAME_RE). */
export function isValidDomain(domain: string): boolean {
  return HOSTNAME_RE.test(domain)
}

/**
 * Parse + validate argv. The domain is positional; flags may appear anywhere.
 * PURE: returns the parsed args or THROWS an `Error` (never touches process) so it
 * is unit-testable; the CLI entrypoint wraps it to print usage + exit.
 */
export function parseArgs(argv: string[]): CliArgs {
  let domain: string | undefined
  let skipBuild = false
  let dryRun = false
  let namespace: string | undefined
  let configPath: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (tok === '--skip-build') {
      skipBuild = true
    } else if (tok === '--dry-run') {
      dryRun = true
    } else if (tok === '--config') {
      const next = argv[i + 1]
      if (next === undefined || next.length === 0 || next.startsWith('--')) {
        throw new Error('--config requires a path argument')
      }
      configPath = next
      i++
    } else if (tok === '--namespace') {
      const next = argv[i + 1]
      if (next === undefined || next.length === 0 || next.startsWith('--')) {
        throw new Error('--namespace requires a namespace argument')
      }
      namespace = next
      i++
    } else if (tok === '-h' || tok === '--help') {
      throw new Error('help')
    } else if (tok.startsWith('--')) {
      throw new Error(`unknown flag: ${tok}`)
    } else if (domain === undefined) {
      domain = tok
    }
  }

  if (!domain) {
    throw new Error('a <domain> argument is required')
  }
  if (!isValidDomain(domain)) {
    throw new Error(
      `invalid domain "${domain}" — pass a bare hostname like app.example.com ` +
        `(dot-separated labels of a–z, 0–9 and '-', no scheme, path, underscore, ` +
        `whitespace, leading/trailing hyphen or trailing dot).`,
    )
  }

  return { domain, skipBuild, dryRun, namespace, configPath }
}

/** parseArgs + turn any error into usage-to-stderr + exit(1) for the CLI path. */
function parseArgsOrExit(argv: string[]): CliArgs {
  try {
    return parseArgs(argv)
  } catch (err) {
    process.stderr.write(USAGE + '\n')
    const msg = err instanceof Error ? err.message : String(err)
    if (msg === 'help') process.exit(1)
    fail(msg)
  }
}

// ---------------------------------------------------------------------------
// Config + secrets-file loading
// ---------------------------------------------------------------------------

/**
 * Discover + load the deploy config from the config dir. Honors `--config`, else
 * tries `smithy-node-deploy.config.mjs` then `.json`. `.mjs` is imported (its
 * `default` export taken); `.json` is read + parsed. Exits 1 with an actionable
 * message if nothing is found.
 */
async function loadConfig(configDir: string, override: string | undefined): Promise<NodeDeployConfig> {
  const candidates = override
    ? [isAbsolute(override) ? override : resolve(configDir, override)]
    : [
        resolve(configDir, 'smithy-node-deploy.config.mjs'),
        resolve(configDir, 'smithy-node-deploy.config.json'),
      ]

  for (const abs of candidates) {
    if (!existsSync(abs)) continue
    if (abs.endsWith('.json')) {
      const raw = readFileSync(abs, 'utf8')
      log(`loaded config: ${abs}`)
      return JSON.parse(raw) as NodeDeployConfig
    }
    const mod = (await import(pathToFileURL(abs).href)) as { default?: NodeDeployConfig }
    if (!mod.default) {
      fail(`config "${abs}" has no default export — export your defineNodeDeployConfig(...) as default.`)
    }
    log(`loaded config: ${abs}`)
    return mod.default
  }

  fail(
    `no deploy config found (looked for ${candidates.join(', ')}). ` +
      `Create smithy-node-deploy.config.mjs exporting defineNodeDeployConfig({ ... }) as default ` +
      `(from '@smithy-hono/deploy-node'), or pass --config <path>.`,
  )
}

/**
 * Load the gitignored secrets file IF any secret declares `from: 'secretsFile'`.
 * Returns `{}` when no secret needs it. Exits 1 when a secret needs it but the file
 * is missing.
 */
function loadSecretsFile(config: NodeDeployConfig, configDir: string): Record<string, string> {
  const needsFile = (config.secrets ?? []).some((s) => 'from' in s && s.from === 'secretsFile')
  const path = resolve(configDir, config.secretsFile ?? 'deploy.secrets.json')
  if (!needsFile) return {}
  if (!existsSync(path)) {
    fail(
      `secrets file not found at ${path} but a secret is declared { from: 'secretsFile' }. ` +
        `Create it as a JSON object keyed by secret name (and gitignore it).`,
    )
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
}

// ---------------------------------------------------------------------------
// Generic command runner (docker / kubectl / sh)
// ---------------------------------------------------------------------------

interface RunResult {
  status: number
  /** Child stdout ONLY (capture mode); empty in inherit mode. */
  stdout: string
  /** Child stderr ONLY (capture mode); empty in inherit mode. */
  stderr: string
}

/** stdout+stderr concatenated — for human-facing logs + error messages only. */
function combined(res: RunResult): string {
  return res.stdout + res.stderr
}

/**
 * Run an external command. In the default capture mode stdout and stderr are
 * captured SEPARATELY; `inherit` streams the child's IO straight through (used for
 * build/apply so progress is visible). `input` is piped to the child's stdin (used
 * to feed rendered YAML to `kubectl apply -f -`).
 */
function run(
  cmd: string,
  args: string[],
  opts: { input?: string; cwd?: string; inherit?: boolean } = {},
): RunResult {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    input: opts.input,
    stdio: opts.inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    env: process.env,
  })
  const status = res.status ?? (res.error ? 1 : 0)
  const stdout = opts.inherit ? '' : (res.stdout ?? '')
  const stderr = opts.inherit ? '' : (res.stderr ?? '')
  return { status, stdout, stderr }
}

// ---------------------------------------------------------------------------
// Preflight: docker + kubectl present
// ---------------------------------------------------------------------------

/**
 * Ensure the CLIs the deploy shells out to are runnable. Exits 1 with actionable
 * guidance if `docker` or `kubectl` is missing. `--dry-run` skips this (it renders
 * manifests only).
 */
function ensureTools(cwd: string): void {
  const docker = run('docker', ['--version'], { cwd })
  if (docker.status !== 0) {
    fail("docker not found — install Docker and ensure it's on PATH.")
  }
  log(`docker: ${combined(docker).trim().split('\n')[0] || 'ok'}`)

  const kubectl = run('kubectl', ['version', '--client'], { cwd })
  if (kubectl.status !== 0) {
    fail("kubectl not found — install it and point it at your cluster (KUBECONFIG / current-context).")
  }
  log(`kubectl: ${combined(kubectl).trim().split('\n')[0] || 'ok'}`)
}

// ---------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------

interface DeployState {
  /** Logical image role (`api` / `web`) → the image ref last built (and pushed). */
  images: Record<string, string>
  /** Whether the manifests have been applied at least once for this domain. */
  applied: boolean
}

/**
 * Slugify a domain for filesystem-safe state-file naming: a readable slug PLUS a
 * short hash of the exact lowercased domain, so distinct hostnames that would
 * otherwise collapse to one readable slug (e.g. `a.b.example.com`, `a-b.example.com`)
 * get DISTINCT state files. Not a public API.
 */
export function domainSlug(domain: string): string {
  const lower = domain.toLowerCase()
  const readable = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const hash = createHash('sha256').update(lower).digest('hex').slice(0, 8)
  return `${readable}-${hash}`
}

/** Load persisted deploy state for this domain (defaults to empty), ensuring the dir exists. */
function loadState(configDir: string, slug: string): { state: DeployState; path: string } {
  const dir = resolve(configDir, '.smithy-deploy-node')
  mkdirSync(dir, { recursive: true })
  const path = resolve(dir, `${slug}.json`)
  let state: DeployState = { images: {}, applied: false }
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DeployState>
    state = {
      images: parsed.images ?? {},
      applied: parsed.applied ?? false,
    }
  }
  return { state, path }
}

/** Persist deploy state (called after each successful step). */
function saveState(path: string, state: DeployState): void {
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n')
}

// ---------------------------------------------------------------------------
// Image naming
// ---------------------------------------------------------------------------

/** Trim any trailing slashes from a registry base (we always join with a single `/`). */
function normalizeRegistry(registry: string): string {
  return registry.replace(/\/+$/, '')
}

/**
 * Compute the fully-qualified image refs. When a registry is set the repo is
 * `<registry>/<appName>[-web]:<tag>` (pushed); otherwise just `<appName>[-web]:<tag>`
 * built locally (kubectl apply then assumes a locally-available image).
 */
export function computeImages(config: NodeDeployConfig): { image: string; webImage: string } {
  const tag = config.imageTag ?? 'latest'
  const base = config.registry ? `${normalizeRegistry(config.registry)}/` : ''
  return {
    image: `${base}${config.appName}:${tag}`,
    webImage: `${base}${config.appName}-web:${tag}`,
  }
}

// ---------------------------------------------------------------------------
// Build + push
// ---------------------------------------------------------------------------

/** Run the SPA build command (`sh -c`) in the config dir, inheriting IO. Exits 1 on failure. */
function buildUi(cmd: string, cwd: string): void {
  log(`build ui: ${cmd}`)
  const res = spawnSync('sh', ['-c', cmd], { cwd, stdio: 'inherit', env: process.env })
  const status = res.status ?? (res.error ? 1 : 0)
  if (status !== 0) {
    fail(`SPA build failed (exit ${status}): ${cmd}`)
  }
}

/** `docker build -f <dockerfile> -t <image> <context>` (context = config dir). Exits 1 on failure. */
function dockerBuild(dockerfile: string, image: string, contextDir: string): void {
  log(`docker build -t ${image} (-f ${dockerfile})`)
  const res = run('docker', ['build', '-f', dockerfile, '-t', image, contextDir], {
    cwd: contextDir,
    inherit: true,
  })
  if (res.status !== 0) {
    fail(`docker build failed for "${image}" (exit ${res.status}).`, res.status || 1)
  }
}

/** `docker push <image>`. Exits 1 on failure. */
function dockerPush(image: string, cwd: string): void {
  log(`docker push ${image}`)
  const res = run('docker', ['push', image], { cwd, inherit: true })
  if (res.status !== 0) {
    fail(`docker push failed for "${image}" (exit ${res.status}).`, res.status || 1)
  }
}

// ---------------------------------------------------------------------------
// Secret sync
// ---------------------------------------------------------------------------

/**
 * Create/replace the per-app k8s `Secret` from the materialized secrets via
 * `kubectl create secret generic <appName>-secrets --from-literal=… --dry-run=client
 * -o yaml | kubectl apply -f -` (the render + apply are two spawns so the SECOND
 * command's argv never carries the values). Secret VALUES are never logged/persisted.
 * No-op when the config declares no secrets.
 */
function syncSecret(
  config: NodeDeployConfig,
  fileValues: Record<string, string>,
  namespace: string,
  cwd: string,
): void {
  const specs = config.secrets ?? []
  if (specs.length === 0) {
    log('secrets: none declared (skip)')
    return
  }
  const names = objectNames(config.appName)
  const literals: string[] = []
  for (const spec of specs) {
    const value = materializeSecret(spec, fileValues)
    literals.push(`--from-literal=${spec.name}=${value}`)
  }
  log(`secret ${names.secret}: create/replace (${specs.length} key(s))`)
  const rendered = run(
    'kubectl',
    ['create', 'secret', 'generic', names.secret, '--namespace', namespace, ...literals, '--dry-run=client', '-o', 'yaml'],
    { cwd },
  )
  if (rendered.status !== 0) {
    // kubectl echoes flag names but not the piped stdin; the --from-literal values
    // ARE on this argv, so scrub them from any surfaced error.
    fail(`failed to render Secret "${names.secret}" (kubectl exited ${rendered.status}).`)
  }
  const applied = run('kubectl', ['apply', '-f', '-'], { input: rendered.stdout, cwd })
  if (applied.status !== 0) {
    fail(`failed to apply Secret "${names.secret}" (kubectl exited ${applied.status}):\n${combined(applied)}`)
  }
}

// ---------------------------------------------------------------------------
// Apply + rollout + verify
// ---------------------------------------------------------------------------

/** `kubectl apply -f -` the rendered manifests. Exits 1 on failure. */
function applyManifests(manifests: string, namespace: string, cwd: string): void {
  log(`kubectl apply (namespace ${namespace})`)
  const res = run('kubectl', ['apply', '--namespace', namespace, '-f', '-'], { input: manifests, cwd })
  process.stderr.write(combined(res))
  if (res.status !== 0) {
    fail(`kubectl apply failed (exit ${res.status}).`, res.status || 1)
  }
}

/** `kubectl rollout status deploy/<name>` (best-effort per deployment; warns, doesn't fail). */
function rolloutStatus(deployment: string, namespace: string, cwd: string): void {
  log(`rollout: deploy/${deployment}`)
  const res = run(
    'kubectl',
    ['rollout', 'status', `deploy/${deployment}`, '--namespace', namespace, '--timeout=180s'],
    { cwd, inherit: true },
  )
  if (res.status !== 0) {
    log(`warning: rollout for deploy/${deployment} did not complete (exit ${res.status}) — check the cluster.`)
  }
}

/**
 * Poll `https://<domain><apiPrefix>/healthz` up to ~10 times. A 200 ends early;
 * giving up only WARNS (TLS/DNS/ingress can lag — never fail the deploy on the probe).
 */
async function verifyHealth(domain: string, apiPrefix: string): Promise<void> {
  const url = `https://${domain}${apiPrefix}/healthz`
  log(`verify: probing ${url}`)
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const resp = await fetch(url)
      if (resp.status === 200) {
        log(`verify: healthy (200) on attempt ${attempt}`)
        return
      }
      log(`verify: attempt ${attempt} got ${resp.status}`)
    } catch {
      log(`verify: attempt ${attempt} failed (not reachable yet)`)
    }
    if (attempt < 10) await sleep(3000)
  }
  log('warning: /healthz never returned 200 — the deploy may still be fine (TLS/DNS/ingress can lag).')
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgsOrExit(process.argv.slice(2))
  const configDir = process.cwd()
  const { domain } = args

  // 1. Load config + resolve derived values.
  const config = await loadConfig(configDir, args.configPath)
  const apiPrefix = apiPrefixOf(config)
  const namespace = args.namespace ?? config.namespace ?? 'default'
  const { image, webImage } = computeImages(config)

  // 2. Render manifests (pure).
  const manifests = renderManifests(config, {
    domain,
    apiPrefix,
    namespace,
    image,
    webImage: config.web ? webImage : undefined,
  })

  // 3. --dry-run: emit the manifests to stdout and stop (no docker/kubectl).
  if (args.dryRun) {
    log('dry-run: rendering manifests to stdout (no docker/kubectl)')
    process.stdout.write(manifests)
    return
  }

  // 4. Preflight tools.
  ensureTools(configDir)

  // 5. Secrets file (only if a secret needs it).
  const fileValues = loadSecretsFile(config, configDir)

  // 6. State file.
  const slug = domainSlug(domain)
  const { state, path: statePath } = loadState(configDir, slug)

  // 7. Build the SPA (host-side) unless skipped.
  if (config.web?.buildCommand && !args.skipBuild) {
    buildUi(config.web.buildCommand, configDir)
  } else if (args.skipBuild) {
    log('build ui: skipped (--skip-build)')
  }

  // 8. Build the API image (context = config dir).
  const dockerfile = resolve(configDir, config.dockerfile ?? 'Dockerfile')
  dockerBuild(dockerfile, image, configDir)
  state.images.api = image
  saveState(statePath, state)

  // 9. Build the web (nginx) image when a front-door is configured. The nginx
  //    Dockerfile is rendered to disk (app-agnostic: nginx + the built SPA).
  if (config.web) {
    const webDockerfile = resolve(configDir, '.smithy-deploy-node', 'web.Dockerfile')
    writeFileSync(webDockerfile, renderWebDockerfile(config.web.dir))
    dockerBuild(webDockerfile, webImage, configDir)
    state.images.web = webImage
    saveState(statePath, state)
  }

  // 10. Push when a registry is configured (else the images stay local).
  if (config.registry) {
    dockerPush(image, configDir)
    if (config.web) dockerPush(webImage, configDir)
  } else {
    log('registry: unset — images built locally, NOT pushed (cluster must have local access).')
  }

  // 11. Sync the Secret BEFORE apply (the API Deployment binds it via envFrom).
  syncSecret(config, fileValues, namespace, configDir)

  // 12. Apply the manifests.
  applyManifests(manifests, namespace, configDir)
  state.applied = true
  saveState(statePath, state)

  // 13. Wait for the rollout(s).
  const names = objectNames(config.appName)
  rolloutStatus(names.api, namespace, configDir)
  if (config.web) rolloutStatus(names.web, namespace, configDir)

  // 14. Verify + report.
  await verifyHealth(domain, apiPrefix)

  // Machine-relevant final output → stdout.
  process.stdout.write(`https://${domain}\n`)
}

/**
 * Only run the orchestration when invoked as the CLI entrypoint (bin), NOT when
 * imported by a test/consumer. `realpathSync` resolves the npm bin symlink to the
 * real module path so the comparison holds when installed as a package bin.
 */
function isCliEntrypoint(): boolean {
  const invoked = process.argv[1]
  if (!invoked) return false
  try {
    return pathToFileURL(realpathSync(invoked)).href === import.meta.url
  } catch {
    return false
  }
}

if (isCliEntrypoint()) {
  main().catch((err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
