import { describe, it, expect } from 'vitest'
import { isValidDomain, domainSlug, parseStackOutputs, hostOfUrl } from './deploy.js'

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

describe('parseStackOutputs', () => {
  it('extracts the named stack outputs', () => {
    const json = JSON.stringify({
      demo: { CloudFrontDomain: 'd123.cloudfront.net', TableName: 'demo-data' },
      other: { X: 'y' },
    })
    expect(parseStackOutputs(json, 'demo')).toEqual({
      CloudFrontDomain: 'd123.cloudfront.net',
      TableName: 'demo-data',
    })
  })
  it('returns {} for a missing stack', () => {
    expect(parseStackOutputs(JSON.stringify({ other: { X: 'y' } }), 'demo')).toEqual({})
  })
  it('returns {} for garbage', () => {
    expect(parseStackOutputs('not json', 'demo')).toEqual({})
    expect(parseStackOutputs('null', 'demo')).toEqual({})
  })
  it('drops non-string output values', () => {
    const json = JSON.stringify({ demo: { A: 'x', B: 42, C: { nested: true } } })
    expect(parseStackOutputs(json, 'demo')).toEqual({ A: 'x' })
  })
})

describe('hostOfUrl', () => {
  it('extracts the host from a Function URL', () => {
    expect(hostOfUrl('https://abc.lambda-url.us-east-1.on.aws/')).toBe('abc.lambda-url.us-east-1.on.aws')
  })
  it('returns undefined for a non-URL', () => {
    expect(hostOfUrl('not a url')).toBeUndefined()
  })
})
