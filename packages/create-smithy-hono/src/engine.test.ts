import { describe, expect, it } from 'vitest'
import {
  isValidAppName,
  resolveOptions,
  toPascalCase,
  toSlug,
  productionStore,
  deployPackage,
  adapterPackage,
  ciProviders,
} from './options.js'
import { deepMerge, mergeAll } from './merge.js'
import { render, hasTokens } from './render.js'
import { planScaffold, assetsConfigSnippet } from './plan.js'
import { emittedName } from './scaffold.js'
import { parseCliArgs } from './index.js'

describe('options', () => {
  it('validates app names', () => {
    expect(isValidAppName('my-app')).toBe(true)
    expect(isValidAppName('app_1.2')).toBe(true)
    expect(isValidAppName('My-App')).toBe(false) // uppercase
    expect(isValidAppName('')).toBe(false)
    expect(isValidAppName('..')).toBe(false)
    expect(isValidAppName('node_modules')).toBe(false)
    expect(isValidAppName('.hidden')).toBe(false)
  })

  it('derives smithy-safe identifiers', () => {
    expect(toPascalCase('my-todo-app')).toBe('MyTodoApp')
    expect(toPascalCase('123')).toBe('App123')
    expect(toPascalCase('___')).toBe('App')
    expect(toSlug('My App!')).toBe('my-app')
  })

  it('maps targets to stores/packages', () => {
    expect(productionStore('cloudflare')).toBe('d1')
    expect(productionStore('node')).toBe('redis')
    expect(productionStore('aws')).toBe('dynamodb')
    expect(deployPackage('node').pkg).toBe('@smithy-hono/deploy-node')
    expect(adapterPackage('aws')).toBe('@smithy-hono/adapter-aws')
  })

  it('resolves + defaults options and rejects bad input', () => {
    expect(resolveOptions({ appName: 'x' })).toEqual({
      appName: 'x',
      target: 'cloudflare',
      frontend: 'fullstack',
      auth: 'none',
      ci: 'github',
    })
    expect(() => resolveOptions({ appName: 'Bad Name' })).toThrow(/invalid project name/)
    expect(() => resolveOptions({ appName: 'x', ci: 'jenkins' as never })).toThrow(/unknown ci/)
  })

  it('expands ci choices to concrete providers', () => {
    expect(ciProviders('github')).toEqual(['github'])
    expect(ciProviders('gitlab')).toEqual(['gitlab'])
    expect(ciProviders('both')).toEqual(['github', 'gitlab'])
    expect(ciProviders('none')).toEqual([])
  })
})

describe('deepMerge', () => {
  it('merges objects recursively', () => {
    expect(deepMerge({ a: { x: 1 }, b: 2 }, { a: { y: 3 }, b: 9 })).toEqual({
      a: { x: 1, y: 3 },
      b: 9,
    })
  })
  it('concatenates + dedupes arrays', () => {
    expect(deepMerge(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c'])
  })
  it('replaces scalars and unlike types', () => {
    expect(deepMerge(1, 'two')).toBe('two')
    expect(deepMerge({ a: 1 }, [1, 2])).toEqual([1, 2])
  })
  it('mergeAll reduces fragments left to right', () => {
    expect(mergeAll([{ scripts: { a: '1' } }, { scripts: { b: '2' } }])).toEqual({
      scripts: { a: '1', b: '2' },
    })
  })
})

describe('render', () => {
  it('substitutes known tokens', () => {
    expect(render('name={{APP_NAME}} v{{SH_VERSION}}', { APP_NAME: 'x', SH_VERSION: '1' })).toBe(
      'name=x v1',
    )
  })
  it('leaves shell/JS ${...} untouched', () => {
    expect(render('https://${domain}/api', {})).toBe('https://${domain}/api')
  })
  it('throws on an unknown token', () => {
    expect(() => render('{{NOPE}}', {})).toThrow(/unknown token/)
  })
  it('hasTokens detects placeholders', () => {
    expect(hasTokens('a {{B}} c')).toBe(true)
    expect(hasTokens('no tokens')).toBe(false)
  })
})

describe('plan', () => {
  it('orders layers and includes ui only for full-stack', () => {
    expect(
      planScaffold({ appName: 'a', target: 'cloudflare', frontend: 'fullstack', auth: 'none', ci: 'none' }).layers,
    ).toEqual(['base', 'app-none', 'ui-none', 'deploy-cloudflare-none'])
    expect(
      planScaffold({ appName: 'a', target: 'aws', frontend: 'api-only', auth: 'oidc', ci: 'none' }).layers,
    ).toEqual(['base', 'app-oidc', 'deploy-aws-oidc'])
  })
  it('appends ci layers per provider, keyed by target', () => {
    expect(
      planScaffold({ appName: 'a', target: 'node', frontend: 'api-only', auth: 'none', ci: 'github' }).layers,
    ).toEqual(['base', 'app-none', 'deploy-node-none', 'ci-github-node'])
    expect(
      planScaffold({ appName: 'a', target: 'aws', frontend: 'api-only', auth: 'none', ci: 'both' }).layers,
    ).toEqual(['base', 'app-none', 'deploy-aws-none', 'ci-github-aws', 'ci-gitlab-aws'])
  })
  it('builds the substitution map', () => {
    const { subs } = planScaffold({ appName: 'My-App', target: 'node', frontend: 'fullstack', auth: 'none', ci: 'github' })
    expect(subs.APP_NAME).toBe('My-App')
    expect(subs.APP_SLUG).toBe('my-app')
    expect(subs.DEPLOY_PKG).toBe('@smithy-hono/deploy-node')
    expect(subs.ADAPTER_PKG).toBe('@smithy-hono/adapter-node')
  })
  it('assets snippet is empty for api-only, per-target for full-stack', () => {
    expect(assetsConfigSnippet('cloudflare', 'api-only')).toBe('')
    expect(assetsConfigSnippet('cloudflare', 'fullstack')).toContain("apiPrefix: '/api'")
    expect(assetsConfigSnippet('node', 'fullstack')).toContain('web: {')
    expect(assetsConfigSnippet('aws', 'fullstack')).toContain('spa: {')
  })
})

describe('scaffold helpers', () => {
  it('renames leading-underscore dotfiles', () => {
    expect(emittedName('_gitignore')).toBe('.gitignore')
    expect(emittedName('_npmrc')).toBe('.npmrc')
    expect(emittedName('package.json')).toBe('package.json')
  })
})

describe('parseCliArgs', () => {
  it('parses positional name + flags', () => {
    expect(parseCliArgs(['myapp', '--target', 'aws', '--auth', 'oidc', '--ci', 'gitlab', '--yes'])).toEqual({
      appName: 'myapp',
      target: 'aws',
      frontend: undefined,
      auth: 'oidc',
      ci: 'gitlab',
      yes: true,
    })
  })
  it('rejects invalid enum values', () => {
    expect(() => parseCliArgs(['--target', 'gcp'])).toThrow(/invalid --target/)
    expect(() => parseCliArgs(['--ci', 'jenkins'])).toThrow(/invalid --ci/)
  })
})
