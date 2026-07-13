/**
 * Integration test: run the REAL template layers through the scaffolder into a temp
 * dir for every supported combination, asserting the output is coherent. Because
 * `render()` throws on an unknown `{{TOKEN}}`, this is also the guard that every
 * template only references tokens the planner provides.
 *
 * COMBOS is expanded as target/auth layers land; the final assertion requires the
 * full cartesian matrix so a missing layer fails loudly.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

import { TARGETS, FRONTENDS, AUTHS, CIS, resolveOptions } from './options.js'
import { planScaffold } from './plan.js'
import { runScaffold } from './scaffold.js'

const templatesRoot = fileURLToPath(new URL('../templates', import.meta.url))
const tmpRoots: string[] = []

afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
})

/** Every layer a combo needs must exist under templates/ for it to be scaffoldable. */
function comboIsBuilt(target: string, frontend: string, auth: string, ci: string): boolean {
  const opts = resolveOptions({
    appName: 'probe',
    target: target as never,
    frontend: frontend as never,
    auth: auth as never,
    ci: ci as never,
  })
  return planScaffold(opts).layers.every((l) => existsSync(join(templatesRoot, l)))
}

const allCombos = TARGETS.flatMap((target) =>
  FRONTENDS.flatMap((frontend) =>
    AUTHS.flatMap((auth) => CIS.map((ci) => ({ target, frontend, auth, ci }))),
  ),
)

describe('scaffold integration (real templates)', () => {
  for (const { target, frontend, auth, ci } of allCombos) {
    const name = `${target}/${frontend}/${auth}/ci:${ci}`
    const built = comboIsBuilt(target, frontend, auth, ci)
    it.skipIf(!built)(`scaffolds ${name} with no leftover tokens`, () => {
      const dest = mkdtempSync(join(tmpdir(), 'sh-scaffold-'))
      tmpRoots.push(dest)
      const opts = resolveOptions({ appName: 'demo-app', target, frontend, auth, ci })
      const { files } = runScaffold(templatesRoot, dest, planScaffold(opts))

      // Core files always present.
      expect(files).toContain('package.json')
      expect(files).toContain('model/main.smithy')
      expect(files).toContain('src/createApp.ts')

      // package.json merged into valid JSON with the codegen + deploy scripts.
      const pkg = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'))
      expect(pkg.name).toBe('demo-app')
      expect(pkg.scripts.codegen).toBe('./gradlew syncGeneratedCode')
      expect(pkg.scripts.deploy).toBeTruthy()

      // Full-stack ships a ui/ workspace; api-only does not.
      if (frontend === 'fullstack') {
        expect(files).toContain('ui/package.json')
        expect(pkg.workspaces).toContain('ui')
      } else {
        expect(files.some((f) => f.startsWith('ui/'))).toBe(false)
      }

      // CI pipelines land at their real dotfile paths per the chosen provider(s).
      const wantsGithub = ci === 'github' || ci === 'both'
      const wantsGitlab = ci === 'gitlab' || ci === 'both'
      expect(files.includes('.github/workflows/ci.yml')).toBe(wantsGithub)
      expect(files.includes('.gitlab-ci.yml')).toBe(wantsGitlab)

      // No unrendered template tokens anywhere in the emitted text files. We match
      // the real token grammar ({{UPPER_SNAKE}}) rather than a bare '{{' so that
      // legitimate `${{ ... }}` GitHub Actions expressions in the CI templates —
      // which render() intentionally leaves alone — don't read as leftovers.
      for (const rel of files) {
        if (/\.(jar|png|ico|woff2?)$/.test(rel)) continue
        expect(readFileSync(join(dest, rel), 'utf8'), rel).not.toMatch(/\{\{[A-Z0-9_]+\}\}/)
      }
    })
  }

  it('covers the full target × frontend × auth × ci matrix once all layers exist', () => {
    const missing = allCombos
      .filter((c) => !comboIsBuilt(c.target, c.frontend, c.auth, c.ci))
      .map((c) => `${c.target}/${c.frontend}/${c.auth}/ci:${c.ci}`)
    // NOTE: while the matrix is still being built out, this lists the combos whose
    // template layers are not yet authored. It must be empty for a complete release.
    expect(missing).toEqual([])
  })
})
