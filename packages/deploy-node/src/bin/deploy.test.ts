import { describe, it, expect } from 'vitest'
import { isValidDomain, domainSlug, parseArgs, computeImages } from './deploy.js'
import type { NodeDeployConfig } from '../config.js'

describe('isValidDomain', () => {
  it('accepts bare hostnames', () => {
    for (const d of ['app.example.com', 'a.b.example.com', 'a-b.example.com', 'x1.co', 'example.com']) {
      expect(isValidDomain(d), d).toBe(true)
    }
  })

  it('rejects underscores, scheme, path, whitespace, trailing/leading dashes and dots', () => {
    for (const d of [
      '',
      'a_b.example.com',
      'https://app.example.com',
      'app.example.com/path',
      'app .example.com',
      'app.example.com.',
      '-app.example.com',
      'app-.example.com',
      'app..example.com',
      '.example.com',
    ]) {
      expect(isValidDomain(d), d).toBe(false)
    }
  })

  it('rejects labels longer than 63 chars', () => {
    expect(isValidDomain(`${'a'.repeat(64)}.example.com`)).toBe(false)
    expect(isValidDomain(`${'a'.repeat(63)}.example.com`)).toBe(true)
  })
})

describe('domainSlug', () => {
  it('is deterministic for a given domain', () => {
    expect(domainSlug('app.example.com')).toBe(domainSlug('app.example.com'))
  })

  it('does NOT collide distinct hostnames that share a readable slug', () => {
    expect(domainSlug('a.b.example.com')).not.toBe(domainSlug('a-b.example.com'))
  })

  it('is case-insensitive on the input', () => {
    expect(domainSlug('APP.Example.COM')).toBe(domainSlug('app.example.com'))
  })

  it('is filesystem-safe (only [a-z0-9-])', () => {
    expect(domainSlug('a.b.example.com')).toMatch(/^[a-z0-9-]+$/)
  })
})

describe('parseArgs', () => {
  it('parses a bare domain with defaults', () => {
    expect(parseArgs(['app.example.com'])).toEqual({
      domain: 'app.example.com',
      skipBuild: false,
      dryRun: false,
      namespace: undefined,
      configPath: undefined,
    })
  })

  it('parses flags in any position', () => {
    const args = parseArgs(['--dry-run', 'app.example.com', '--skip-build', '--namespace', 'prod', '--config', './c.mjs'])
    expect(args).toEqual({
      domain: 'app.example.com',
      skipBuild: true,
      dryRun: true,
      namespace: 'prod',
      configPath: './c.mjs',
    })
  })

  it('throws when no domain is given', () => {
    expect(() => parseArgs(['--dry-run'])).toThrow(/domain/)
  })

  it('throws on an invalid domain', () => {
    expect(() => parseArgs(['not a domain'])).toThrow(/invalid domain/)
  })

  it('throws on an unknown flag', () => {
    expect(() => parseArgs(['app.example.com', '--nope'])).toThrow(/unknown flag/)
  })

  it('throws when --namespace has no argument', () => {
    expect(() => parseArgs(['app.example.com', '--namespace'])).toThrow(/namespace/)
  })

  it('signals help via a thrown "help" marker', () => {
    expect(() => parseArgs(['--help'])).toThrow('help')
  })
})

describe('computeImages', () => {
  it('registry-prefixes and tags both images when a registry is set', () => {
    const config: NodeDeployConfig = { appName: 'demo', registry: 'registry.example.com/me', imageTag: 'v3' }
    expect(computeImages(config)).toEqual({
      image: 'registry.example.com/me/demo:v3',
      webImage: 'registry.example.com/me/demo-web:v3',
    })
  })

  it('trims a trailing slash on the registry base', () => {
    const config: NodeDeployConfig = { appName: 'demo', registry: 'registry.example.com/me/' }
    expect(computeImages(config).image).toBe('registry.example.com/me/demo:latest')
  })

  it('builds local (unprefixed) images defaulting to :latest when no registry is set', () => {
    expect(computeImages({ appName: 'demo' })).toEqual({
      image: 'demo:latest',
      webImage: 'demo-web:latest',
    })
  })
})
