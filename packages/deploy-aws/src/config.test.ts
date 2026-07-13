import { describe, it, expect } from 'vitest'
import { defineAwsDeployConfig, apiPrefixOf } from './config.js'
import type { AwsDeployConfig } from './config.js'

describe('defineAwsDeployConfig', () => {
  it('is an identity helper (returns the same object)', () => {
    const c: AwsDeployConfig = { appName: 'demo' }
    expect(defineAwsDeployConfig(c)).toBe(c)
  })
})

describe('apiPrefixOf', () => {
  it('defaults to /api when no spa is configured', () => {
    expect(apiPrefixOf({ appName: 'demo' })).toBe('/api')
  })

  it('defaults to /api when spa omits apiPrefix', () => {
    expect(apiPrefixOf({ appName: 'demo', spa: { dir: 'web/dist' } })).toBe('/api')
  })

  it('honors an explicit spa.apiPrefix', () => {
    expect(apiPrefixOf({ appName: 'demo', spa: { dir: 'web/dist', apiPrefix: '/backend' } })).toBe(
      '/backend',
    )
  })
})

describe('config shape (contract)', () => {
  it('accepts the full documented config', () => {
    const c = defineAwsDeployConfig({
      appName: 'demo',
      handlerEntry: 'src/handler.ts',
      region: 'us-east-1',
      spa: { dir: 'web/dist', buildCommand: 'npm run build', apiPrefix: '/api' },
      domainName: 'app.example.com',
      certificateArn: 'arn:aws:acm:us-east-1:1:certificate/x',
      tableName: 'demo-data',
      env: ({ domain, apiPrefix }) => ({ REDIRECT: `https://${domain}${apiPrefix}/cb` }),
      secrets: [
        { name: 'SIGNING_KEY', generate: 'hmac-hex' },
        { name: 'IDP_SECRET', from: 'secretsFile' },
      ],
      secretsFile: 'deploy.secrets.json',
    })
    expect(c.appName).toBe('demo')
    expect(c.env?.({ domain: 'x.com', apiPrefix: '/api' })).toEqual({ REDIRECT: 'https://x.com/api/cb' })
  })
})
