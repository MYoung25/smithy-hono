#!/usr/bin/env node
/**
 * `@smithy-hono/create` — the `npm create @smithy-hono` scaffolder.
 *
 * Interactively (or via flags) collects the project name, deploy target
 * (Cloudflare / Node / AWS), full-stack-vs-API-only, and auth flavor, then overlays
 * the matching template layers into a new project directory wired to the right
 * `@smithy-hono/deploy-*` CLI. Node APIs are confined to this bin; the planning /
 * merge / render / scaffold library stays pure + unit-tested.
 *
 * Usage:
 *   npm create @smithy-hono@latest [name] -- [--target cloudflare|node|aws]
 *     [--frontend fullstack|api-only] [--auth none|oidc]
 *     [--ci github|gitlab|both|none] [--yes]
 */
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  resolveOptions,
  isValidAppName,
  TARGETS,
  FRONTENDS,
  AUTHS,
  CIS,
  type Auth,
  type Ci,
  type Frontend,
  type ScaffoldOptions,
  type Target,
} from './options.js'
import { planScaffold } from './plan.js'
import { isNonEmptyDir, ensureDestDir, runScaffold } from './scaffold.js'
import { ask, confirm, openPrompt, select } from './prompt.js'

const USAGE = `@smithy-hono/create — scaffold a smithy-hono app

Usage:
  npm create @smithy-hono@latest [name] -- [flags]

Flags:
  --target <cloudflare|node|aws>     deploy target (installs the matching deploy CLI)
  --frontend <fullstack|api-only>    ship a same-origin React SPA, or an API only
  --auth <none|oidc>                 anonymous CRUD, or OIDC cookie-session security
  --ci <github|gitlab|both|none>     build+deploy pipeline templates to emit
  --yes                              accept defaults for anything not provided
  -h, --help                         show this help`

export interface CliArgs {
  appName: string | undefined
  target: Target | undefined
  frontend: Frontend | undefined
  auth: Auth | undefined
  ci: Ci | undefined
  yes: boolean
}

/** Parse argv (flags may appear in any order; first positional is the app name). */
export function parseCliArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    appName: undefined,
    target: undefined,
    frontend: undefined,
    auth: undefined,
    ci: undefined,
    yes: false,
  }
  const takeEnum = <T extends string>(val: string | undefined, allowed: readonly T[], flag: string): T => {
    if (val === undefined) throw new Error(`${flag} requires a value (one of ${allowed.join(', ')})`)
    if (!(allowed as readonly string[]).includes(val)) {
      throw new Error(`invalid ${flag} "${val}" — expected one of ${allowed.join(', ')}`)
    }
    return val as T
  }
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (tok === '--target') out.target = takeEnum(argv[++i], TARGETS, '--target')
    else if (tok === '--frontend') out.frontend = takeEnum(argv[++i], FRONTENDS, '--frontend')
    else if (tok === '--auth') out.auth = takeEnum(argv[++i], AUTHS, '--auth')
    else if (tok === '--ci') out.ci = takeEnum(argv[++i], CIS, '--ci')
    else if (tok === '--yes' || tok === '-y') out.yes = true
    else if (tok === '-h' || tok === '--help') {
      process.stdout.write(USAGE + '\n')
      process.exit(0)
    } else if (tok.startsWith('-')) {
      throw new Error(`unknown flag: ${tok}`)
    } else if (out.appName === undefined) {
      out.appName = tok
    }
  }
  return out
}

/** Fill any unspecified options — interactively when on a TTY, else via defaults. */
async function collectOptions(args: CliArgs): Promise<ScaffoldOptions> {
  const interactive = process.stdin.isTTY && process.stdout.isTTY && !args.yes
  let { appName, target, frontend, auth, ci } = args

  if (!interactive) {
    return resolveOptions({
      appName: appName ?? 'my-smithy-app',
      target: target ?? 'cloudflare',
      frontend: frontend ?? 'fullstack',
      auth: auth ?? 'none',
      ci: ci ?? 'github',
    })
  }

  const rl = openPrompt()
  let aborted = false
  try {
    intro()
    process.stdout.write(
      "\nProject name\n  Used as the new directory, the npm package name, and the seed for your\n  Smithy service id (e.g. 'my-todo-app' → service MyTodoApp).\n",
    )
    while (!appName || !isValidAppName(appName)) {
      appName = await ask(rl, 'Project name', appName ?? 'my-smithy-app')
      if (!isValidAppName(appName)) {
        process.stdout.write(`  "${appName}" is not a valid package/directory name — try again.\n`)
      }
    }
    target ??= await select<Target>(
      rl,
      'Deploy target?',
      [
        { value: 'cloudflare', label: 'Cloudflare Workers', hint: 'one-command deploy, same-origin /api + SPA' },
        { value: 'node', label: 'Node (Docker + Kubernetes)', hint: 'container image + nginx front-door' },
        { value: 'aws', label: 'AWS (CDK: Lambda + CloudFront)', hint: 'serverless, CloudFront same-origin' },
      ],
      'Where this app deploys. Each target installs its matching one-command deploy CLI and a durable store.',
    )
    frontend ??= await select<Frontend>(
      rl,
      'Include a frontend?',
      [
        { value: 'fullstack', label: 'Full-stack', hint: 'React + Vite SPA served same-origin with the API' },
        { value: 'api-only', label: 'API only', hint: 'no UI — just the generated HTTP API' },
      ],
      'Ship a React SPA served same-origin with the API (no CORS), or a bare HTTP API.',
    )
    auth ??= await select<Auth>(
      rl,
      'Authentication?',
      [
        { value: 'none', label: 'None', hint: 'anonymous CRUD demo (Task resource)' },
        { value: 'oidc', label: 'OIDC sessions', hint: 'security-core pipeline + cookie login (Note resource)' },
      ],
      'Start anonymous, or generate the full OIDC cookie-session security pipeline.',
    )
    ci ??= await select<Ci>(
      rl,
      'CI/CD pipeline?',
      [
        { value: 'github', label: 'GitHub Actions', hint: '.github/workflows — build+test on PR, deploy on main' },
        { value: 'gitlab', label: 'GitLab CI', hint: '.gitlab-ci.yml — build+test on MR, deploy on main' },
        { value: 'both', label: 'Both', hint: 'emit GitHub Actions and GitLab CI' },
        { value: 'none', label: 'None', hint: 'no CI/CD templates' },
      ],
      'Generate a build + test + deploy pipeline (keyless deploy) for your git host. Runs on every push/PR; deploys on main.',
    )

    process.stdout.write(
      `\nAbout to create:\n` +
        `  ${appName}/  →  target: ${target}, ${frontend}, auth: ${auth}, ci: ${ci}\n\n`,
    )
    aborted = !(await confirm(rl, 'Create it?', true))
  } finally {
    rl.close()
  }

  if (aborted) {
    process.stdout.write('\nAborted — nothing was written. Re-run to start over.\n')
    process.exit(0)
  }

  return resolveOptions({ appName, target, frontend, auth, ci })
}

/** The interactive wizard's welcome banner — sets expectations before the prompts. */
function intro(): void {
  process.stdout.write(
    '\n' +
      'create-smithy-hono\n' +
      'Scaffold a typed Hono API generated from a Smithy model, wired to a one-command deploy.\n' +
      '\n' +
      'Answer a few questions — press Enter to accept each [default]. Nothing is written\n' +
      'until you confirm at the end.\n',
  )
}

function nextSteps(opts: ScaffoldOptions): string {
  const lines = [
    '',
    `✔ Scaffolded ${opts.appName} (${opts.target}, ${opts.frontend}, auth: ${opts.auth}, ci: ${opts.ci})`,
    '',
    'Next steps:',
    `  cd ${opts.appName}`,
    '  npm install',
    '  npm run codegen        # Smithy → src/generated (needs JDK 21)',
    '  npm run dev            # local API on :3000',
  ]
  if (opts.frontend === 'fullstack') lines.push('  npm --prefix ui run dev   # SPA on :5173, proxying /api → :3000')
  lines.push('')
  if (opts.auth === 'oidc') {
    lines.push('  # Fill in your IdP facts in the deploy config + deploy.secrets.json before deploying.')
  }
  lines.push('  npm run deploy -- <your-domain>   # build + provision + deploy, UI+API same-origin')
  if (opts.ci !== 'none') {
    const files =
      opts.ci === 'both'
        ? '.github/workflows/ci.yml + .gitlab-ci.yml'
        : opts.ci === 'gitlab'
          ? '.gitlab-ci.yml'
          : '.github/workflows/ci.yml'
    lines.push('')
    lines.push(`  # CI/CD: ${files} builds+tests every push/PR and deploys on main.`)
    lines.push('  #   Set the credentials + DEPLOY_DOMAIN it documents (see the file header) before the first deploy.')
  }
  lines.push('')
  return lines.join('\n')
}

/** Locate the shipped templates dir relative to this module (dist/ or src/). */
function templatesRoot(): string {
  return fileURLToPath(new URL('../templates', import.meta.url))
}

async function main(): Promise<void> {
  let args: CliArgs
  try {
    args = parseCliArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(USAGE + '\n\nerror: ' + (err instanceof Error ? err.message : String(err)) + '\n')
    process.exit(1)
    return
  }

  const opts = await collectOptions(args)
  const destRoot = resolve(process.cwd(), opts.appName)

  if (isNonEmptyDir(destRoot)) {
    process.stderr.write(`error: ${destRoot} already exists and is not empty — choose another name.\n`)
    process.exit(1)
  }
  ensureDestDir(destRoot)

  const plan = planScaffold(opts)
  const { files } = runScaffold(templatesRoot(), destRoot, plan)
  process.stderr.write(`created ${files.length} files in ${opts.appName}/\n`)
  process.stdout.write(nextSteps(opts))
}

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
