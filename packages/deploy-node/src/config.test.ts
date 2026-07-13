import { describe, it, expect } from 'vitest'
import { defineNodeDeployConfig, apiPrefixOf } from './config.js'
import type { NodeDeployConfig } from './config.js'

describe('defineNodeDeployConfig', () => {
  it('is an identity helper (returns the same object)', () => {
    const c: NodeDeployConfig = { appName: 'demo' }
    expect(defineNodeDeployConfig(c)).toBe(c)
  })
})

describe('apiPrefixOf', () => {
  it('defaults to /api when no web front-door is configured', () => {
    expect(apiPrefixOf({ appName: 'demo' })).toBe('/api')
  })

  it('defaults to /api when web is set without an apiPrefix', () => {
    expect(apiPrefixOf({ appName: 'demo', web: { dir: 'web/dist' } })).toBe('/api')
  })

  it('honors an explicit web.apiPrefix', () => {
    expect(apiPrefixOf({ appName: 'demo', web: { dir: 'web/dist', apiPrefix: '/gateway' } })).toBe(
      '/gateway',
    )
  })
})
