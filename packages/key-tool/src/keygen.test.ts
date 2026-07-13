/**
 * keygen tests (OPS-03): the HMAC secret floor (KEY-TOOL-03) and basic shape.
 */

import { describe, it, expect } from 'vitest'
import { generateHmacSecret, DEFAULT_SECRET_BYTES, MIN_SECRET_BYTES } from './keygen.js'

describe('generateHmacSecret', () => {
  it('generates DEFAULT_SECRET_BYTES of base64 material by default', () => {
    const b64 = generateHmacSecret()
    const len = atob(b64).length
    expect(len).toBe(DEFAULT_SECRET_BYTES)
  })

  it('rejects a non-positive / non-integer byteLength', () => {
    expect(() => generateHmacSecret(0)).toThrow(RangeError)
    expect(() => generateHmacSecret(-1)).toThrow(RangeError)
    expect(() => generateHmacSecret(8.5)).toThrow(RangeError)
  })

  it('rejects a byteLength below the MIN_SECRET_BYTES floor (KEY-TOOL-03)', () => {
    expect(MIN_SECRET_BYTES).toBeGreaterThanOrEqual(16)
    expect(() => generateHmacSecret(1)).toThrow(/>= 16/)
    expect(() => generateHmacSecret(MIN_SECRET_BYTES - 1)).toThrow(RangeError)
  })

  it('accepts exactly MIN_SECRET_BYTES', () => {
    const b64 = generateHmacSecret(MIN_SECRET_BYTES)
    expect(atob(b64).length).toBe(MIN_SECRET_BYTES)
  })
})
