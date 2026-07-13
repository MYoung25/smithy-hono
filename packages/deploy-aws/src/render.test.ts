import { describe, it, expect } from 'vitest'
import {
  resolveTableName,
  resolveRegion,
  usesCustomDomain,
  resolveCustomDomain,
  healthProbeHost,
  computeLambdaEnv,
  buildCdkInput,
} from './render.js'
import type { AwsDeployConfig } from './config.js'

const base: AwsDeployConfig = { appName: 'demo' }

describe('resolveTableName', () => {
  it('defaults to `${appName}-data`', () => {
    expect(resolveTableName(base)).toBe('demo-data')
  })
  it('honors an explicit tableName', () => {
    expect(resolveTableName({ ...base, tableName: 'my-table' })).toBe('my-table')
  })
})

describe('resolveRegion (precedence: config > CDK_DEFAULT_REGION > AWS_REGION)', () => {
  it('prefers the config region', () => {
    expect(resolveRegion({ ...base, region: 'eu-west-1' }, { CDK_DEFAULT_REGION: 'us-east-1' })).toBe(
      'eu-west-1',
    )
  })
  it('falls back to CDK_DEFAULT_REGION', () => {
    expect(resolveRegion(base, { CDK_DEFAULT_REGION: 'us-east-2', AWS_REGION: 'us-west-1' })).toBe(
      'us-east-2',
    )
  })
  it('falls back to AWS_REGION', () => {
    expect(resolveRegion(base, { AWS_REGION: 'ap-south-1' })).toBe('ap-south-1')
  })
  it('is undefined when nothing is set', () => {
    expect(resolveRegion(base, {})).toBeUndefined()
  })
})

describe('custom-domain resolution', () => {
  it('needs BOTH domainName and certificateArn', () => {
    expect(usesCustomDomain({ ...base, domainName: 'a.com' })).toBe(false)
    expect(usesCustomDomain({ ...base, certificateArn: 'arn:x' })).toBe(false)
    expect(usesCustomDomain({ ...base, domainName: 'a.com', certificateArn: 'arn:x' })).toBe(true)
  })
  it('resolveCustomDomain returns the domain only when fully wired', () => {
    expect(resolveCustomDomain({ ...base, domainName: 'a.com' })).toBeUndefined()
    expect(resolveCustomDomain({ ...base, domainName: 'a.com', certificateArn: 'arn:x' })).toBe('a.com')
  })
})

describe('healthProbeHost', () => {
  it('prefers the custom domain when wired', () => {
    const cfg = { ...base, domainName: 'a.com', certificateArn: 'arn:x' }
    expect(healthProbeHost(cfg, 'd123.cloudfront.net')).toBe('a.com')
  })
  it('falls back to the CloudFront domain otherwise', () => {
    expect(healthProbeHost(base, 'd123.cloudfront.net')).toBe('d123.cloudfront.net')
  })
  it('is undefined when neither is available', () => {
    expect(healthProbeHost(base, undefined)).toBeUndefined()
  })
})

describe('computeLambdaEnv', () => {
  it('includes TABLE + API_PREFIX and merges config.env', () => {
    const cfg: AwsDeployConfig = {
      appName: 'demo',
      spa: { dir: 'web/dist', apiPrefix: '/backend' },
      env: ({ domain, apiPrefix }) => ({ REDIRECT: `https://${domain}${apiPrefix}/cb` }),
    }
    const env = computeLambdaEnv(cfg, { domain: 'app.example.com', apiPrefix: '/backend' })
    expect(env.TABLE).toBe('demo-data')
    expect(env.API_PREFIX).toBe('/backend')
    expect(env.REDIRECT).toBe('https://app.example.com/backend/cb')
  })

  it('adds SECRET_NAMES (comma-joined) when secrets are declared', () => {
    const cfg: AwsDeployConfig = {
      appName: 'demo',
      secrets: [
        { name: 'A', generate: 'hmac-hex' },
        { name: 'B', from: 'secretsFile' },
      ],
    }
    const env = computeLambdaEnv(cfg, { domain: 'x.com', apiPrefix: '/api' })
    expect(env.SECRET_NAMES).toBe('A,B')
  })

  it('omits SECRET_NAMES when there are no secrets', () => {
    const env = computeLambdaEnv(base, { domain: 'x.com', apiPrefix: '/api' })
    expect('SECRET_NAMES' in env).toBe(false)
  })
})

describe('buildCdkInput', () => {
  const cfg: AwsDeployConfig = {
    appName: 'demo',
    spa: { dir: 'web/dist' },
    domainName: 'app.example.com',
    certificateArn: 'arn:x',
    secrets: [{ name: 'A', generate: 'hmac-hex' }],
  }

  it('assembles a fully-resolved, serializable input', () => {
    const input = buildCdkInput(
      cfg,
      { domain: 'app.example.com', apiPrefix: '/api' },
      { A: 'deadbeef' },
      { handlerEntry: '/abs/src/handler.ts', spaDir: '/abs/web/dist' },
    )
    expect(input).toEqual({
      appName: 'demo',
      handlerEntry: '/abs/src/handler.ts',
      region: undefined,
      tableName: 'demo-data',
      apiPrefix: '/api',
      domainName: 'app.example.com',
      certificateArn: 'arn:x',
      spa: { dir: '/abs/web/dist' },
      env: { TABLE: 'demo-data', API_PREFIX: '/api', SECRET_NAMES: 'A' },
      secrets: [{ name: 'A', value: 'deadbeef' }],
    })
    // Round-trips through JSON (the CLI writes it to a temp file for the CDK app).
    expect(JSON.parse(JSON.stringify(input)).secrets[0].value).toBe('deadbeef')
  })

  it('omits spa for an API-only config', () => {
    const input = buildCdkInput(
      { appName: 'demo' },
      { domain: 'x.com', apiPrefix: '/api' },
      {},
      { handlerEntry: '/abs/src/handler.ts' },
    )
    expect(input.spa).toBeUndefined()
  })

  it('throws when a declared secret has no materialized value', () => {
    expect(() =>
      buildCdkInput(cfg, { domain: 'x.com', apiPrefix: '/api' }, {}, {
        handlerEntry: '/abs/src/handler.ts',
        spaDir: '/abs/web/dist',
      }),
    ).toThrow(/no materialized value/)
  })
})
