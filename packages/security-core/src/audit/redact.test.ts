import { describe, it, expect } from 'vitest'
import { redactSensitive, REDACTED } from './redact.js'

describe('redactSensitive (RT-13)', () => {
  it('redacts a top-level sensitive field', () => {
    const out = redactSensitive({ id: '1', password: 'hunter2' }, ['password'])
    expect(out).toEqual({ id: '1', password: REDACTED })
  })

  it('redacts a nested dot-path', () => {
    const out = redactSensitive({ body: { name: 'x', token: 'abc' } }, ['body.token'])
    expect(out).toEqual({ body: { name: 'x', token: REDACTED } })
  })

  it('distributes a path across array elements', () => {
    const out = redactSensitive(
      { items: [{ token: 'a' }, { token: 'b' }] },
      ['items.token'],
    )
    expect(out).toEqual({ items: [{ token: REDACTED }, { token: REDACTED }] })
  })

  it('never mutates the input', () => {
    const input = { password: 'hunter2' }
    redactSensitive(input, ['password'])
    expect(input.password).toBe('hunter2')
  })

  it('ignores unknown paths and is a no-op without paths', () => {
    expect(redactSensitive({ a: 1 }, ['missing.path'])).toEqual({ a: 1 })
    expect(redactSensitive({ a: 1 }, undefined)).toEqual({ a: 1 })
    expect(redactSensitive({ a: 1 }, [])).toEqual({ a: 1 })
  })

  it('returns primitives unchanged', () => {
    expect(redactSensitive('plain', ['x'])).toBe('plain')
    expect(redactSensitive(42, ['x'])).toBe(42)
  })

  it('redacts multiple paths at once', () => {
    const out = redactSensitive(
      { user: { ssn: '123', email: 'a@b.c' }, public: 'ok' },
      ['user.ssn', 'user.email'],
    )
    expect(out).toEqual({ user: { ssn: REDACTED, email: REDACTED }, public: 'ok' })
  })

  it('never pollutes Object.prototype via __proto__/constructor paths (AUDIT-LOGGING-01)', () => {
    redactSensitive({}, ['__proto__.toString'])
    redactSensitive({}, ['__proto__.hasOwnProperty'])
    redactSensitive({}, ['constructor.prototype.polluted'])
    // Prototype methods must be intact and uncorrupted afterwards.
    expect(({}).toString()).toBe('[object Object]')
    expect(typeof ({}).hasOwnProperty).toBe('function')
    expect((Object.prototype as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('only redacts OWN properties, never inherited prototype members', () => {
    // `toString` exists on the prototype but not as an own property → no-op.
    const out = redactSensitive({ a: 1 }, ['toString'])
    expect(out).toEqual({ a: 1 })
  })
})
