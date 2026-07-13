import { describe, it, expect } from 'vitest'
import { materializeSecret, base64ToHex } from './secrets.js'

describe('materializeSecret — generated', () => {
  it('hmac-hex is lowercase hex of even length (default 32 bytes = 64 chars)', () => {
    const v = materializeSecret({ name: 'X', generate: 'hmac-hex' }, {})
    expect(v).toMatch(/^[0-9a-f]+$/)
    expect(v.length % 2).toBe(0)
    expect(v.length).toBe(64)
  })

  it('honors a custom byte length', () => {
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

  it('generates a fresh value each call (CSPRNG)', () => {
    const a = materializeSecret({ name: 'X', generate: 'random-base64' }, {})
    const b = materializeSecret({ name: 'X', generate: 'random-base64' }, {})
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

  it('throws when the value is empty', () => {
    expect(() => materializeSecret({ name: 'X', from: 'secretsFile' }, { X: '' })).toThrow()
  })
})

describe('base64ToHex', () => {
  it('round-trips a known value', () => {
    const b64 = Buffer.from('hello', 'utf8').toString('base64')
    expect(base64ToHex(b64)).toBe('68656c6c6f')
  })
})
