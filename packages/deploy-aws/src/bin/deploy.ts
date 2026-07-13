#!/usr/bin/env node
/**
 * `smithy-hono-deploy-aws` — the one-command AWS same-origin deploy orchestrator.
 *
 * Run from a consuming smithy-hono project directory (the config dir =
 * `process.cwd()`). Given a bare domain it: loads the deploy config, builds the
 * SPA, materializes secrets (values never logged; generated values cached in the
 * gitignored state file so re-runs are idempotent and don't rotate keys), writes
 * the fully-resolved stack input to a temp file, drives `cdk deploy` (the CDK app
 * ships as source under `cdk/`), parses the CloudFront domain from the CDK
 * outputs, and health-probes `<domain-or-cloudfront><apiPrefix>/healthz`.
 *
 * The CDK app + cdk.json live inside THIS installed package (they ship via
 * `files`), so `cdk deploy` is run with the package dir as cwd; the config-dir
 * relative paths (handlerEntry, spa.dir) are resolved to ABSOLUTE paths and
 * passed through the input file so the stack resolves them correctly.
 *
 * Secret values are conveyed to CDK via a temp FILE path (`-c inputFile=`), never
 * argv, so they never appear in a process listing. The temp file is written 0600
 * and unlinked in a `finally`.
 *
 * Node APIs (argv, fs, child_process, fetch) are intentionally confined to this
 * CLI file; the importable library surface (config/render/secrets) stays pure.
 *
 * Usage:
 *   smithy-hono-deploy-aws <domain> [--skip-build] [--config <path>] [--region <r>] [--rotate-keys]
 */

import process from 'node:process'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { resolve, isAbsolute, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

import { apiPrefixOf, type AwsDeployConfig, type SecretSpec } from '../config.js'
import { materializeSecret } from '../secrets.js'
import { buildCdkInput, healthProbeHost, resolveCustomDomain } from '../render.js'

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

const USAGE = `smithy-hono-deploy-aws — one-command AWS same-origin deploy

Usage:
  smithy-hono-deploy-aws <domain> [--skip-build] [--config <path>] [--region <r>] [--rotate-keys]

Arguments:
  <domain>          Bare hostname the app is served at (e.g. app.example.com). No
                    scheme, path, whitespace or trailing dot. Bound on CloudFront
                    only when the config also sets domainName + certificateArn;
                    otherwise the CloudFront default domain is used and probed.

Flags:
  --skip-build      Skip the SPA build step.
  --config <path>   Path to the deploy config (overrides auto-discovery).
  --region <r>      AWS region (overrides config.region / CDK_DEFAULT_REGION).
  --rotate-keys     Force regeneration of all generated secrets.`

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface CliArgs {
  domain: string
  skipBuild: boolean
  rotateKeys: boolean
  configPath: string | undefined
  region: string | undefined
}

/**
 * Parse + validate argv. The domain is positional; flags may appear anywhere.
 * Prints usage + exits 1 on any bad input.
 */
function parseArgs(argv: string[]): CliArgs {
  let domain: string | undefined
  let skipBuild = false
  let rotateKeys = false
  let configPath: string | undefined
  let region: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (tok === '--skip-build') {
      skipBuild = true
    } else if (tok === '--rotate-keys') {
      rotateKeys = true
    } else if (tok === '--config') {
      configPath = argv[i + 1]
      i++
    } else if (tok === '--region') {
      region = argv[i + 1]
      i++
    } else if (tok === '-h' || tok === '--help') {
      process.stderr.write(USAGE + '\n')
      process.exit(1)
    } else if (tok.startsWith('--')) {
      process.stderr.write(USAGE + '\n')
      fail(`unknown flag: ${tok}`)
    } else if (domain === undefined) {
      domain = tok
    }
  }

  if (configPath !== undefined && configPath.length === 0) {
    process.stderr.write(USAGE + '\n')
    fail('--config requires a path argument')
  }
  if (region !== undefined && region.length === 0) {
    process.stderr.write(USAGE + '\n')
    fail('--region requires a value')
  }
  if (!domain) {
    process.stderr.write(USAGE + '\n')
    fail('a <domain> argument is required')
  }
  validateDomain(domain)

  return { domain, skipBuild, rotateKeys, configPath, region }
}

/**
 * Strict DNS-hostname grammar: dot-separated labels, each 1–63 chars of
 * `[a-z0-9-]`, no leading/trailing hyphen, total ≤ 253 chars. Rejects `_`,
 * consecutive dots, scheme/path/whitespace and trailing dots. Case-insensitive.
 * Stricter than "no scheme/path": distinct forms like `a_b` vs `a-b` must NOT be
 * accepted, else the state-file slug would alias them.
 */
const HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i

/** True iff `domain` is a syntactically valid bare DNS hostname (see HOSTNAME_RE). */
export function isValidDomain(domain: string): boolean {
  return HOSTNAME_RE.test(domain)
}

/** Reject anything that is not a bare hostname. Exits 1 (with usage) on failure. */
function validateDomain(domain: string): void {
  if (!isValidDomain(domain)) {
    process.stderr.write(USAGE + '\n')
    fail(
      `invalid domain "${domain}" — pass a bare hostname like app.example.com ` +
        `(dot-separated labels of a–z, 0–9 and '-', no scheme, path, underscore, ` +
        `whitespace, leading/trailing hyphen or trailing dot).`,
    )
  }
}

// ---------------------------------------------------------------------------
// Config + secrets-file loading
// ---------------------------------------------------------------------------

/**
 * Discover + load the deploy config from the config dir. Honors `--config`, else
 * tries `smithy-aws-deploy.config.mjs` then `.json`. `.mjs` is imported (its
 * `default` export taken); `.json` is read + parsed. Exits 1 with an actionable
 * message if nothing is found.
 */
async function loadConfig(
  configDir: string,
  override: string | undefined,
): Promise<AwsDeployConfig> {
  const candidates = override
    ? [isAbsolute(override) ? override : resolve(configDir, override)]
    : [
        resolve(configDir, 'smithy-aws-deploy.config.mjs'),
        resolve(configDir, 'smithy-aws-deploy.config.json'),
      ]

  for (const abs of candidates) {
    if (!existsSync(abs)) continue
    if (abs.endsWith('.json')) {
      const raw = readFileSync(abs, 'utf8')
      log(`loaded config: ${abs}`)
      return JSON.parse(raw) as AwsDeployConfig
    }
    const mod = (await import(pathToFileURL(abs).href)) as { default?: AwsDeployConfig }
    if (!mod.default) {
      fail(
        `config "${abs}" has no default export — export your defineAwsDeployConfig(...) as default.`,
      )
    }
    log(`loaded config: ${abs}`)
    return mod.default
  }

  fail(
    `no deploy config found (looked for ${candidates.join(', ')}). ` +
      `Create smithy-aws-deploy.config.mjs exporting defineAwsDeployConfig({ ... }) as default ` +
      `(from '@smithy-hono/deploy-aws'), or pass --config <path>.`,
  )
}

/**
 * Load the gitignored secrets file IF any secret declares `from: 'secretsFile'`.
 * Returns `{}` when no secret needs it. Exits 1 when a secret needs it but the
 * file is missing.
 */
function loadSecretsFile(config: AwsDeployConfig, configDir: string): Record<string, string> {
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
// State file
// ---------------------------------------------------------------------------

/**
 * Idempotent per-domain state.
 *
 * DIVERGENCE from deploy-cf: deploy-cf never persists secret VALUES (wrangler
 * stores them server-side, so it only records a per-name "provisioned" boolean).
 * On AWS the value flows THROUGH the CLI into the CDK template, so to keep
 * GENERATED secrets stable across re-runs (no key rotation on every deploy) we
 * cache the generated values here. This file lives under `.smithy-deploy-aws/`
 * and MUST be gitignored. `--rotate-keys` regenerates them. Values sourced from
 * the secrets file are NEVER cached — they are re-read from that file each run.
 */
interface DeployState {
  /** Generated secret name → cached value (for idempotent, non-rotating deploys). */
  generatedSecrets: Record<string, string>
}

/**
 * Slugify a domain for filesystem-safe state-file naming: a readable slug PLUS a
 * short hash of the exact lowercased domain, so distinct hostnames that share a
 * readable slug (e.g. `a.b.example.com`, `a-b.example.com`) get DISTINCT state.
 */
export function domainSlug(domain: string): string {
  const lower = domain.toLowerCase()
  const readable = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const hash = createHash('sha256').update(lower).digest('hex').slice(0, 8)
  return `${readable}-${hash}`
}

/** Load persisted deploy state for this domain (defaults to empty), ensuring the dir exists. */
function loadState(configDir: string, slug: string): { state: DeployState; path: string } {
  const dir = resolve(configDir, '.smithy-deploy-aws')
  mkdirSync(dir, { recursive: true })
  const path = resolve(dir, `${slug}.json`)
  let state: DeployState = { generatedSecrets: {} }
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DeployState>
    state = { generatedSecrets: parsed.generatedSecrets ?? {} }
  }
  return { state, path }
}

/** Persist deploy state (0600 — it holds generated secret values). */
function saveState(path: string, state: DeployState): void {
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/**
 * Resolve every declared secret to a concrete value: `from: 'secretsFile'`
 * secrets are read from the file each run; generated secrets reuse the cached
 * value from state unless absent or `--rotate-keys` is set, in which case a fresh
 * value is minted and cached. Returns a name→value map. Values are never logged.
 */
function resolveSecrets(
  config: AwsDeployConfig,
  fileValues: Record<string, string>,
  state: DeployState,
  statePath: string,
  rotateKeys: boolean,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const spec of config.secrets ?? []) {
    if ('from' in spec) {
      out[spec.name] = materializeSecret(spec, fileValues)
      log(`secret ${spec.name}: from secrets file`)
      continue
    }
    const cached = state.generatedSecrets[spec.name]
    if (cached && !rotateKeys) {
      out[spec.name] = cached
      log(`secret ${spec.name}: reuse cached generated value`)
      continue
    }
    const value = materializeSecret(spec as SecretSpec, fileValues)
    state.generatedSecrets[spec.name] = value
    saveState(statePath, state)
    out[spec.name] = value
    log(`secret ${spec.name}: generated${rotateKeys ? ' (rotate)' : ''}`)
  }
  return out
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/** Run the SPA build command (`sh -c`) in the config dir, inheriting IO. Exits 1 on failure. */
function buildSpa(cmd: string, cwd: string): void {
  log(`build: ${cmd}`)
  const res = spawnSync('sh', ['-c', cmd], { cwd, stdio: 'inherit', env: process.env })
  const status = res.status ?? (res.error ? 1 : 0)
  if (status !== 0) {
    fail(`SPA build failed (exit ${status}): ${cmd}`)
  }
}

// ---------------------------------------------------------------------------
// CDK output parsing
// ---------------------------------------------------------------------------

/**
 * Parse `cdk deploy --outputs-file` JSON for the given stack and return its
 * outputs (a flat string→string map), or `{}` when absent/unparseable. Shape:
 * `{ "<StackName>": { "CloudFrontDomain": "...", "FunctionUrl": "...", ... } }`.
 */
export function parseStackOutputs(json: string, stackName: string): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const stack = (parsed as Record<string, unknown>)[stackName]
  if (typeof stack !== 'object' || stack === null) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(stack as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

/** Derive the CloudFront host from a Function URL (`https://xxx.lambda-url.../` → `xxx.lambda-url...`). */
export function hostOfUrl(url: string): string | undefined {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Health probe
// ---------------------------------------------------------------------------

/**
 * Poll `https://<host><apiPrefix>/healthz` up to ~10 times. A 200 ends early;
 * giving up only WARNS (CloudFront/cert propagation can lag — never fail the
 * deploy on the probe).
 */
async function verifyHealth(host: string, apiPrefix: string): Promise<void> {
  const url = `https://${host}${apiPrefix}/healthz`
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
  log('warning: /healthz never returned 200 — the deploy may still be fine (CDN/TLS can lag).')
}

// ---------------------------------------------------------------------------
// Package dir (where the CDK app + cdk.json ship)
// ---------------------------------------------------------------------------

/** Resolve this package's root (dist/bin/deploy.js → package root), where cdk/ + cdk.json live. */
function packageRoot(): string {
  // dist/bin/deploy.js → up two levels → package root.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const configDir = process.cwd()
  const { domain } = args

  // 1. Load config.
  const config = await loadConfig(configDir, args.configPath)
  if (args.region) config.region = args.region

  const apiPrefix = apiPrefixOf(config)
  const fileValues = loadSecretsFile(config, configDir)

  // 2. State (idempotent generated-secret cache).
  const slug = domainSlug(domain)
  const { state, path: statePath } = loadState(configDir, slug)

  // 3. Build the SPA (unless skipped / API-only).
  if (config.spa?.buildCommand && !args.skipBuild) {
    buildSpa(config.spa.buildCommand, configDir)
  } else if (args.skipBuild) {
    log('build: skipped (--skip-build)')
  }

  // 4. Materialize secrets (values never logged; generated values cached).
  const secretValues = resolveSecrets(config, fileValues, state, statePath, args.rotateKeys)

  // 5. Resolve config-dir-relative paths to ABSOLUTE (the stack runs with the
  //    package dir as cwd, so relative paths must be pre-resolved).
  const handlerEntry = resolve(configDir, config.handlerEntry ?? 'src/handler.ts')
  const spaDir = config.spa ? resolve(configDir, config.spa.dir) : undefined

  // 6. Build the fully-resolved stack input.
  const input = buildCdkInput(config, { domain, apiPrefix }, secretValues, {
    handlerEntry,
    spaDir,
  })

  // 7. Write the input to a temp FILE (0600) — secret values go via the file
  //    path, NEVER argv, so they never appear in a process listing.
  const tmpDir = mkdtempSync(resolve(tmpdir(), 'smithy-aws-deploy-'))
  const inputPath = resolve(tmpDir, 'stack-input.json')
  const outputsPath = resolve(tmpDir, 'outputs.json')
  writeFileSync(inputPath, JSON.stringify(input), { mode: 0o600 })

  try {
    // 8. Drive `cdk deploy`. The CDK app + cdk.json ship in THIS package, so run
    //    cdk with the package dir as cwd (cdk.json's `app` resolves cdk/app.ts).
    const pkgRoot = packageRoot()
    const cdkArgs = [
      'cdk',
      'deploy',
      '--require-approval',
      'never',
      '--outputs-file',
      outputsPath,
      '-c',
      `inputFile=${inputPath}`,
      '-c',
      `domain=${domain}`,
    ]
    if (args.region) {
      // Region is also carried in the input file; surface it to CDK's env too.
      process.env.CDK_DEFAULT_REGION = args.region
    }
    log(`deploy: npx cdk deploy (cwd=${pkgRoot})`)
    const deploy = spawnSync('npx', cdkArgs, {
      cwd: pkgRoot,
      stdio: 'inherit',
      env: process.env,
    })
    const status = deploy.status ?? (deploy.error ? 1 : 0)
    if (status !== 0) {
      fail(`cdk deploy failed (exit ${status}).`, status || 1)
    }

    // 9. Parse outputs → CloudFront domain (or Function URL fallback host).
    const outputs = existsSync(outputsPath)
      ? parseStackOutputs(readFileSync(outputsPath, 'utf8'), config.appName)
      : {}
    const cloudfrontDomain = outputs.CloudFrontDomain
    const probeHost =
      healthProbeHost(config, cloudfrontDomain) ??
      (outputs.FunctionUrl ? hostOfUrl(outputs.FunctionUrl) : undefined)

    // 10. Verify + report.
    if (probeHost) {
      await verifyHealth(probeHost, apiPrefix)
    } else {
      log('verify: no reachable host resolved from CDK outputs — skipping health probe.')
    }

    // Machine-relevant final output → stdout.
    const publicHost = resolveCustomDomain(config) ?? cloudfrontDomain
    if (publicHost) {
      process.stdout.write(`https://${publicHost}\n`)
    } else if (outputs.FunctionUrl) {
      process.stdout.write(`${outputs.FunctionUrl}\n`)
    }
  } finally {
    // Best-effort cleanup of the temp secrets file.
    rmSync(tmpDir, { recursive: true, force: true })
  }
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
