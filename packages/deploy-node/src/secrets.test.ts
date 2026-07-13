import { describe, it, expect } from 'vitest'
import { materializeSecret } from './secrets.js'

describe('materializeSecret — generated', () => {
  it('hmac-hex is lowercase hex of even length (default 32 bytes = 64 chars)', () => {
    const v = materializeSecret({ name: 'X', generate: 'hmac-hex' }, {})
    expect(v).toMatch(/^[0-9a-f]+$/)
    expect(v.length % 2).toBe(0)
    expect(v.length).toBe(64)
  })

  it('honors an explicit byte count for hmac-hex (16 bytes = 32 hex chars)', () => {
    const v = materializeSecret({ name: 'X', generate: 'hmac-hex', bytes: 16 }, {})
    expect(v.length).toBe(32)
  })

  it('hmac-base64 decodes to 32 bytes (round-trip)', () => {
    const v = materializeSecret({ name: 'X', generate: 'hmac-base64' }, {})
    const buf = Buffer.from(v, 'base64')
    expect(buf.length).toBe(32)
    expect(buf.toString('base64')).toBe(v)
  })

  it('random-base64 decodes to 32 bytes (round-trip)', () => {
    const v = materializeSecret({ name: 'X', generate: 'random-base64' }, {})
    const buf = Buffer.from(v, 'base64')
    expect(buf.length).toBe(32)
    expect(buf.toString('base64')).toBe(v)
  })

  it('is non-deterministic (CSPRNG) across calls', () => {
    const a = materializeSecret({ name: 'X', generate: 'hmac-hex' }, {})
    const b = materializeSecret({ name: 'X', generate: 'hmac-hex' }, {})
    expect(a).not.toBe(b)
  })
})

describe('materializeSecret — secretsFile', () => {
  it('returns the file value when present', () => {
    expect(materializeSecret({ name: 'X', from: 'secretsFile' }, { X: 'v' })).toBe('v')
  })

  it('throws when the value is missing', () => {
    expect(() => materializeSecret({ name: 'X', from: 'secretsFile' }, {})).toThrow()
  })

  it('throws when the value is present but empty', () => {
    expect(() => materializeSecret({ name: 'X', from: 'secretsFile' }, { X: '' })).toThrow()
  })
})
