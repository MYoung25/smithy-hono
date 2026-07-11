import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { expectError, catchError, expectStatus, TestKitAssertionError } from './assert.js'

class NotFound extends Error {
  constructor(m: string) { super(m); this.name = 'NotFound' }
}

describe('expectError', () => {
  it('returns the error when the right class is thrown', async () => {
    const e = await expectError(async () => { throw new NotFound('nope') }, NotFound)
    expect(e).toBeInstanceOf(NotFound)
    expect(e.message).toBe('nope')
  })

  it('fails when the call resolves', async () => {
    await expect(expectError(async () => 1, NotFound)).rejects.toBeInstanceOf(TestKitAssertionError)
  })

  it('fails when a different error is thrown', async () => {
    await expect(expectError(async () => { throw new Error('other') }, NotFound))
      .rejects.toBeInstanceOf(TestKitAssertionError)
  })
})

describe('catchError', () => {
  it('captures the thrown error', async () => {
    const e = await catchError(async () => { throw new NotFound('x') })
    expect(e).toBeInstanceOf(NotFound)
  })
})

describe('expectStatus', () => {
  it('passes on matching status and fails otherwise', async () => {
    const app = new Hono()
    app.get('/ok', (c) => c.json({}, 200))
    app.get('/bad', (c) => c.json({ code: 'X' }, 404))
    await expectStatus(() => app.request('/ok'), 200)
    await expect(expectStatus(() => app.request('/bad'), 200))
      .rejects.toBeInstanceOf(TestKitAssertionError)
  })
})
