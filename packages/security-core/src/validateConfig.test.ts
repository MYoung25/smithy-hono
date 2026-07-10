import { describe, it, expect } from 'vitest'
import { validateConfig, collectConfigIssues, ConfigValidationError } from './validateConfig.js'
import type { SecurityConfig } from './config.js'
import type { OperationRegistry, PipelineOperationMeta } from './pipeline/index.js'

function op(over: Partial<PipelineOperationMeta>): PipelineOperationMeta {
  return {
    name: 'Op',
    method: 'POST',
    path: '/op',
    authSchemes: [{ type: 'anonymous' }],
    readonly: false,
    requiredPermissions: [],
    cost: 1,
    constraints: { hasConstrainedInput: false },
    ...over,
  }
}

function config(over: Partial<SecurityConfig> = {}): SecurityConfig {
  return {
    allowedOrigins: ['https://app.example.com'],
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
    idleTtlSeconds: 900,
    stores: {},
    // ≥32 chars so the WEAK_AUDIT_SALT strength floor isn't tripped by the default.
    auditSalt: 'deployment-salt-0123456789abcdef-xyz',
    ...over,
  }
}

const registry = (...ops: PipelineOperationMeta[]): OperationRegistry =>
  Object.fromEntries(ops.map((o, i) => [`${o.name}${i}`, o]))

describe('validateConfig — fatal incoherence (OPS-06)', () => {
  it('throws when cookie/OIDC ops have no session store', () => {
    const reg = registry(op({ authSchemes: [{ type: 'oidc' }] }))
    expect(() => validateConfig(reg, config())).toThrow(ConfigValidationError)
    expect(collectConfigIssues(reg, config()).some((i) => i.code === 'MISSING_SESSION_STORE')).toBe(true)
  })

  it('throws when signed ops have no secret store', () => {
    const reg = registry(op({ authSchemes: [{ type: 'sigv4Hmac' }], readonly: true }))
    expect(() => validateConfig(reg, config())).toThrow(/MISSING_SECRET_STORE/)
  })

  it('throws when non-readonly signed ops have no nonce store', () => {
    const reg = registry(op({ authSchemes: [{ type: 'sigv4Hmac' }], readonly: false }))
    const cfg = config({ stores: { secrets: {} as never } })
    const codes = collectConfigIssues(reg, cfg).map((i) => i.code)
    expect(codes).toContain('MISSING_NONCE_STORE')
  })

  it('throws on HSTS under one year', () => {
    const cfg = config({ hsts: { maxAge: 3600, includeSubDomains: true } })
    expect(() => validateConfig(registry(op({})), cfg)).toThrow(/WEAK_HSTS/)
  })

  it('throws on a wildcard CORS origin (credentialed API)', () => {
    const cfg = config({ allowedOrigins: ['*'] })
    expect(() => validateConfig(registry(op({})), cfg)).toThrow(/WILDCARD_CORS_WITH_CREDENTIALS/)
  })

  it('throws on an incomplete oidc config', () => {
    const cfg = config({
      stores: { session: {} as never },
      oidc: { issuer: '', clientId: 'c', audience: 'c', redirectUri: 'r', authorizationEndpoint: 'a', tokenEndpoint: 't', stateSecret: 's' },
    })
    expect(collectConfigIssues(registry(op({})), cfg).some((i) => i.code === 'INCOMPLETE_OIDC')).toBe(true)
  })

  // config-validate-2: empty OIDC audience must be fatal (jose skips aud checks).
  it('throws when oidc.audience is an empty string', () => {
    const cfg = config({
      stores: { session: {} as never },
      oidc: { issuer: 'i', clientId: 'c', audience: '', redirectUri: 'r', authorizationEndpoint: 'a', tokenEndpoint: 't', stateSecret: 'x'.repeat(32) },
    })
    expect(collectConfigIssues(registry(op({})), cfg).some((i) => i.code === 'EMPTY_OIDC_AUDIENCE')).toBe(true)
    expect(() => validateConfig(registry(op({})), cfg)).toThrow(/EMPTY_OIDC_AUDIENCE/)
  })

  it('throws when oidc.audience is an all-empty array', () => {
    const cfg = config({
      stores: { session: {} as never },
      oidc: { issuer: 'i', clientId: 'c', audience: ['', '  '], redirectUri: 'r', authorizationEndpoint: 'a', tokenEndpoint: 't', stateSecret: 'x'.repeat(32) },
    })
    expect(collectConfigIssues(registry(op({})), cfg).some((i) => i.code === 'EMPTY_OIDC_AUDIENCE')).toBe(true)
  })

  it('accepts a non-empty audience array element', () => {
    const cfg = config({
      stores: { session: {} as never },
      oidc: { issuer: 'i', clientId: 'c', audience: ['', 'aud-1'], redirectUri: 'r', authorizationEndpoint: 'a', tokenEndpoint: 't', stateSecret: 'x'.repeat(32) },
    })
    expect(collectConfigIssues(registry(op({})), cfg).some((i) => i.code === 'EMPTY_OIDC_AUDIENCE')).toBe(false)
  })

  // config-validate-6: stateSecret strength floor.
  it('throws on a too-short oidc.stateSecret', () => {
    const cfg = config({
      stores: { session: {} as never },
      oidc: { issuer: 'i', clientId: 'c', audience: 'c', redirectUri: 'r', authorizationEndpoint: 'a', tokenEndpoint: 't', stateSecret: 'x' },
    })
    expect(() => validateConfig(registry(op({})), cfg)).toThrow(/WEAK_STATE_SECRET/)
  })

  it('accepts a 32-char oidc.stateSecret', () => {
    const cfg = config({
      stores: { session: {} as never },
      oidc: { issuer: 'i', clientId: 'c', audience: 'c', redirectUri: 'r', authorizationEndpoint: 'a', tokenEndpoint: 't', stateSecret: 'x'.repeat(32) },
    })
    expect(collectConfigIssues(registry(op({})), cfg).some((i) => i.code === 'WEAK_STATE_SECRET')).toBe(false)
  })

  // config-validate-4: HSTS finite guard + session TTL guards.
  it('throws WEAK_HSTS on a non-finite maxAge (NaN)', () => {
    const cfg = config({ hsts: { maxAge: Number.NaN, includeSubDomains: true } })
    expect(() => validateConfig(registry(op({})), cfg)).toThrow(/WEAK_HSTS/)
  })

  it('throws INVALID_TTL on a non-finite idleTtlSeconds', () => {
    const cfg = config({ idleTtlSeconds: Number.NaN })
    expect(() => validateConfig(registry(op({})), cfg)).toThrow(/INVALID_TTL/)
  })

  it('throws INVALID_TTL on a zero/negative idleTtlSeconds', () => {
    expect(() => validateConfig(registry(op({})), config({ idleTtlSeconds: 0 }))).toThrow(/INVALID_TTL/)
    expect(() => validateConfig(registry(op({})), config({ idleTtlSeconds: -1 }))).toThrow(/INVALID_TTL/)
  })

  it('throws INVALID_TTL on a non-finite/zero session.absoluteTtlSeconds', () => {
    const nan = config({ session: { absoluteTtlSeconds: Number.NaN } })
    expect(() => validateConfig(registry(op({})), nan)).toThrow(/INVALID_TTL/)
    const zero = config({ session: { absoluteTtlSeconds: 0 } })
    expect(() => validateConfig(registry(op({})), zero)).toThrow(/INVALID_TTL/)
  })

  it('throws INVALID_TTL when idleTtlSeconds exceeds session.absoluteTtlSeconds', () => {
    const cfg = config({ idleTtlSeconds: 7200, session: { absoluteTtlSeconds: 3600 } })
    expect(() => validateConfig(registry(op({})), cfg)).toThrow(/INVALID_TTL/)
  })

  it('accepts coherent idle/absolute TTLs', () => {
    const cfg = config({ idleTtlSeconds: 900, session: { absoluteTtlSeconds: 28_800 } })
    expect(collectConfigIssues(registry(op({})), cfg).some((i) => i.code === 'INVALID_TTL')).toBe(false)
  })

  // config-validate-3: acceptanceWindowSeconds bounds.
  it('throws INVALID_ACCEPTANCE_WINDOW on zero/negative/non-integer windows', () => {
    expect(() => validateConfig(registry(op({})), config({ signing: { acceptanceWindowSeconds: 0 } }))).toThrow(/INVALID_ACCEPTANCE_WINDOW/)
    expect(() => validateConfig(registry(op({})), config({ signing: { acceptanceWindowSeconds: -5 } }))).toThrow(/INVALID_ACCEPTANCE_WINDOW/)
    expect(() => validateConfig(registry(op({})), config({ signing: { acceptanceWindowSeconds: 1.5 } }))).toThrow(/INVALID_ACCEPTANCE_WINDOW/)
    expect(() => validateConfig(registry(op({})), config({ signing: { acceptanceWindowSeconds: Number.NaN } }))).toThrow(/INVALID_ACCEPTANCE_WINDOW/)
  })

  it('throws INVALID_ACCEPTANCE_WINDOW above the hard cap (ms-vs-s mistake)', () => {
    const cfg = config({ signing: { acceptanceWindowSeconds: 300_000 } })
    expect(() => validateConfig(registry(op({})), cfg)).toThrow(/INVALID_ACCEPTANCE_WINDOW/)
  })

  it('warns (non-fatal) on a wide-but-capped acceptance window', () => {
    const cfg = config({ signing: { acceptanceWindowSeconds: 1800 } })
    const codes = collectConfigIssues(registry(op({})), cfg)
    expect(codes.some((i) => i.code === 'WIDE_ACCEPTANCE_WINDOW' && !i.fatal)).toBe(true)
    expect(() => validateConfig(registry(op({})), cfg)).not.toThrow()
  })

  it('accepts a sane acceptance window', () => {
    const cfg = config({ signing: { acceptanceWindowSeconds: 300 } })
    const codes = collectConfigIssues(registry(op({})), cfg).map((i) => i.code)
    expect(codes).not.toContain('INVALID_ACCEPTANCE_WINDOW')
    expect(codes).not.toContain('WIDE_ACCEPTANCE_WINDOW')
  })

  it('a coherent config passes and returns only warnings', () => {
    const reg = registry(op({ authSchemes: [{ type: 'anonymous' }] }))
    expect(() => validateConfig(reg, config())).not.toThrow()
  })
})

describe('validateConfig — non-fatal warnings (logged, not thrown)', () => {
  it('warns when auditSalt is unset', () => {
    const warns: Record<string, unknown>[] = []
    const cfg = config({ auditSalt: undefined, logger: { info() {}, warn: (r) => warns.push(r), error() {} } })
    const out = validateConfig(registry(op({})), cfg)
    expect(out.some((i) => i.code === 'NO_AUDIT_SALT')).toBe(true)
    expect(warns.some((w) => w.code === 'NO_AUDIT_SALT')).toBe(true)
  })

  // audit-logging-3: opt-in requireAuditSalt escalates a missing salt to fatal.
  it('NO_AUDIT_SALT is non-fatal by default but FATAL when requireAuditSalt is set', () => {
    const lax = config({ auditSalt: undefined })
    const laxIssue = collectConfigIssues(registry(op({})), lax).find((i) => i.code === 'NO_AUDIT_SALT')
    expect(laxIssue?.fatal).toBe(false)
    expect(() => validateConfig(registry(op({})), lax)).not.toThrow()

    const strict = config({ auditSalt: undefined, requireAuditSalt: true })
    const strictIssue = collectConfigIssues(registry(op({})), strict).find((i) => i.code === 'NO_AUDIT_SALT')
    expect(strictIssue?.fatal).toBe(true)
    expect(() => validateConfig(registry(op({})), strict)).toThrow(/NO_AUDIT_SALT/)
  })

  // config-validate-6: present-but-weak auditSalt is fatal (strength floor).
  it('throws WEAK_AUDIT_SALT on a present-but-too-short auditSalt', () => {
    const cfg = config({ auditSalt: 'a' })
    expect(collectConfigIssues(registry(op({})), cfg).some((i) => i.code === 'WEAK_AUDIT_SALT' && i.fatal)).toBe(true)
    expect(() => validateConfig(registry(op({})), cfg)).toThrow(/WEAK_AUDIT_SALT/)
  })

  it('warns when a limiter is half-configured (defaults but no store)', () => {
    const cfg = config({ rateLimits: {} as never })
    expect(collectConfigIssues(registry(op({})), cfg).some((i) => i.code === 'LIMITER_DISABLED')).toBe(true)
  })

  // --- finding config-validate-1: CORS origin allowlist validation -----------
  const validOidc = {
    issuer: 'https://idp.example.com',
    clientId: 'client-1',
    audience: 'client-1',
    redirectUri: 'https://app.example.com/cb',
    authorizationEndpoint: 'https://idp.example.com/authorize',
    tokenEndpoint: 'https://idp.example.com/token',
    stateSecret: 'state-secret-0123456789abcdef-longer',
  }

  it('throws INVALID_CORS_ORIGIN on a literal "null" origin', () => {
    const cfg = config({ allowedOrigins: ['null'] })
    expect(collectConfigIssues(registry(op({})), cfg).some((i) => i.code === 'INVALID_CORS_ORIGIN' && i.fatal)).toBe(true)
    expect(() => validateConfig(registry(op({})), cfg)).toThrow(/INVALID_CORS_ORIGIN/)
  })

  it('throws INVALID_CORS_ORIGIN on a malformed / path-bearing origin', () => {
    const cfg = config({ allowedOrigins: ['https://app.example.com/'] })
    expect(collectConfigIssues(registry(op({})), cfg).some((i) => i.code === 'INVALID_CORS_ORIGIN' && i.fatal)).toBe(true)
  })

  it('warns on whitespace in an origin entry', () => {
    const cfg = config({ allowedOrigins: [' https://app.example.com'] })
    const issues = collectConfigIssues(registry(op({})), cfg)
    expect(issues.some((i) => i.code === 'CORS_ORIGIN_WHITESPACE' && !i.fatal)).toBe(true)
  })

  it('accepts a well-formed bare origin with a port', () => {
    const cfg = config({ allowedOrigins: ['https://app.example.com:8443'] })
    expect(collectConfigIssues(registry(op({})), cfg).some((i) => i.code === 'INVALID_CORS_ORIGIN')).toBe(false)
  })

  // --- finding: oidc.clockToleranceSeconds validation ------------------------
  it('throws INVALID_CLOCK_TOLERANCE on a negative/NaN tolerance', () => {
    const cfg = config({ oidc: { ...validOidc, clockToleranceSeconds: -1 }, stores: { session: {} as never } })
    expect(collectConfigIssues(registry(op({})), cfg).some((i) => i.code === 'INVALID_CLOCK_TOLERANCE' && i.fatal)).toBe(true)
  })

  it('throws INVALID_CLOCK_TOLERANCE on a ms-vs-s sized tolerance', () => {
    const cfg = config({ oidc: { ...validOidc, clockToleranceSeconds: 60000 }, stores: { session: {} as never } })
    expect(collectConfigIssues(registry(op({})), cfg).some((i) => i.code === 'INVALID_CLOCK_TOLERANCE' && i.fatal)).toBe(true)
  })

  it('accepts a sane clock tolerance', () => {
    const cfg = config({ oidc: { ...validOidc, clockToleranceSeconds: 60 }, stores: { session: {} as never } })
    expect(collectConfigIssues(registry(op({})), cfg).some((i) => i.code === 'INVALID_CLOCK_TOLERANCE')).toBe(false)
  })

  // --- finding: rate-limit token-bucket spec validation ----------------------
  it('throws INVALID_RATE_LIMIT on a non-positive capacity', () => {
    const cfg = config({
      rateLimits: { perIp: { capacity: 0, refillPerSecond: 1 } },
      stores: { rateLimit: {} as never },
    })
    expect(collectConfigIssues(registry(op({})), cfg).some((i) => i.code === 'INVALID_RATE_LIMIT' && i.fatal)).toBe(true)
  })

  it('throws INVALID_RATE_LIMIT on a negative/NaN refillPerSecond', () => {
    const cfg = config({
      rateLimits: { perPrincipal: { capacity: 10, refillPerSecond: Number.NaN } },
      stores: { rateLimit: {} as never },
    })
    expect(collectConfigIssues(registry(op({})), cfg).some((i) => i.code === 'INVALID_RATE_LIMIT' && i.fatal)).toBe(true)
  })

  it('accepts a coherent rate-limit spec', () => {
    const cfg = config({
      rateLimits: { perIp: { capacity: 100, refillPerSecond: 10 } },
      stores: { rateLimit: {} as never },
    })
    expect(collectConfigIssues(registry(op({})), cfg).some((i) => i.code === 'INVALID_RATE_LIMIT')).toBe(false)
  })
})
