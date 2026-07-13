/**
 * The filesystem executor: overlay the planned template layers into a destination
 * directory, applying token substitution, dotfile renaming, and package.json
 * deep-merge. Node `fs` lives here (the pure planning/merge/render logic is in
 * separate modules) so this is the only part that touches disk.
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'

import { deepMerge, type Json } from './merge.js'
import { render, type Substitutions } from './render.js'
import type { ScaffoldPlan } from './plan.js'

/** Extensions copied byte-for-byte (never token-substituted). */
const BINARY_EXT = new Set(['.jar', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2'])

/** Files that must be executable in the generated project. */
const EXECUTABLE = new Set(['gradlew'])

function extname(path: string): string {
  const i = path.lastIndexOf('.')
  return i === -1 ? '' : path.slice(i).toLowerCase()
}

/**
 * Rename a template basename to its emitted form: a leading `_` becomes `.` so a
 * template can carry `_gitignore` / `_npmrc` / `_env.example` through `npm publish`
 * (which strips real dotfiles like `.gitignore` from a package tarball) and land as
 * the real dotfile in the scaffolded project.
 */
export function emittedName(basename: string): string {
  return basename.startsWith('_') ? '.' + basename.slice(1) : basename
}

/** Recursively list files (not dirs) under `root`, as paths relative to `root`. */
function listFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else out.push(relative(root, abs))
    }
  }
  walk(root)
  return out
}

/** Map a template-relative path to its emitted path (renaming each dotfile segment). */
function emittedRelPath(rel: string): string {
  return rel.split('/').map(emittedName).join('/')
}

export interface ScaffoldResult {
  /** Emitted file paths (relative to the destination), sorted. */
  files: string[]
}

/**
 * Execute a plan: overlay `plan.layers` (found under `templatesRoot/<layer>`) into
 * `destRoot`, rendering tokens with `plan.subs`. `package.json` files are treated as
 * deep-merge fragments (rendered, parsed, merged across layers) and written once at
 * the end; every other text file is rendered and written at its emitted path; binary
 * files are copied verbatim. Returns the list of emitted files.
 *
 * Precondition: `destRoot` must not already contain files (checked by the caller).
 */
export function runScaffold(
  templatesRoot: string,
  destRoot: string,
  plan: ScaffoldPlan,
): ScaffoldResult {
  const emitted = new Set<string>()
  let pkg: Json = {}
  let sawPkg = false

  for (const layer of plan.layers) {
    const layerRoot = join(templatesRoot, layer)
    if (!existsSync(layerRoot)) {
      throw new Error(`template layer not found: ${layerRoot}`)
    }
    for (const rel of listFiles(layerRoot)) {
      const src = join(layerRoot, rel)
      const base = rel.split('/').pop() as string

      // Only the ROOT package.json is a deep-merge fragment; a nested one (e.g.
      // `ui/package.json`, a separate workspace package) is copied verbatim.
      if (rel === 'package.json') {
        // Fragment: render tokens, parse, deep-merge into the running package.json.
        const fragment = JSON.parse(render(readFileSync(src, 'utf8'), plan.subs)) as Json
        pkg = deepMerge(pkg, fragment)
        sawPkg = true
        continue
      }

      const destRel = emittedRelPath(rel)
      const dest = join(destRoot, destRel)
      mkdirSync(dirname(dest), { recursive: true })

      if (BINARY_EXT.has(extname(base))) {
        cpSync(src, dest)
      } else {
        writeFileSync(dest, render(readFileSync(src, 'utf8'), plan.subs))
      }
      if (EXECUTABLE.has(base)) chmodSync(dest, 0o755)
      emitted.add(destRel)
    }
  }

  if (sawPkg) {
    const dest = join(destRoot, 'package.json')
    writeFileSync(dest, JSON.stringify(pkg, null, 2) + '\n')
    emitted.add('package.json')
  }

  return { files: [...emitted].sort() }
}

/** True iff `dir` exists and contains at least one entry. */
export function isNonEmptyDir(dir: string): boolean {
  if (!existsSync(dir)) return false
  return readdirSync(dir).length > 0
}

/** Ensure a fresh destination directory exists (creating parents). */
export function ensureDestDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}
