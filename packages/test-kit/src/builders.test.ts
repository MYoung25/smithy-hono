import { describe, it, expect } from 'vitest'
import { principal, isPrincipal, sessionRecord, fakeContext } from './builders.js'

describe('principal', () => {
  it('applies defaults and overrides', () => {
    expect(principal()).toEqual({ id: 'test-principal', permissions: [], kind: 'user', claims: {} })
    const p = principal({ permissions: ['a'], id: 'u1', kind: 'service', tenantId: 't1', claims: { x: 1 } })
    expect(p).toEqual({ id: 'u1', permissions: ['a'], kind: 'service', tenantId: 't1', claims: { x: 1 } })
  })

  it('omits tenantId when not provided', () => {
    expect('tenantId' in principal()).toBe(false)
  })
})

describe('isPrincipal', () => {
  it('distinguishes a principal from an options bag', () => {
    expect(isPrincipal(principal())).toBe(true)
    expect(isPrincipal({ permissions: ['a'] })).toBe(false) // no `kind`
    expect(isPrincipal({ ttlSeconds: 10 })).toBe(false)
    expect(isPrincipal(undefined)).toBe(false)
  })
})

describe('sessionRecord', () => {
  it('builds a record with future expiry and a csrf token', () => {
    const rec = sessionRecord({ principal: principal({ permissions: ['p'] }), csrfToken: 'tok' })
    expect(rec.csrfToken).toBe('tok')
    expect(rec.principal.permissions).toEqual(['p'])
    expect(rec.absoluteExpiry).toBeGreaterThan(rec.createdAt)
  })
})

describe('fakeContext', () => {
  it('supports get/set/var over security variables', () => {
    const c = fakeContext({ principal: principal({ id: 'u9' }) })
    expect(c.get('principal')?.id).toBe('u9')
    c.set('resource', { ownerId: 'u9' })
    expect((c.get('resource') as { ownerId: string }).ownerId).toBe('u9')
    expect(c.var.principal).toBeDefined()
  })
})
