import { describe, it, expect } from 'vitest'
import { withBasePath, resolveOp, type OperationRegistry } from './index.js'

const REG: OperationRegistry = {
  ListNotes: {
    name: 'ListNotes',
    method: 'GET',
    path: '/notes',
    authSchemes: [{ type: 'oidc' }],
    readonly: true,
    requiredPermissions: ['notes.read'],
    cost: 1,
    constraints: { hasConstrainedInput: false },
  },
  GetNote: {
    name: 'GetNote',
    method: 'GET',
    path: '/notes/:id',
    authSchemes: [{ type: 'oidc' }],
    readonly: true,
    requiredPermissions: ['notes.read'],
    cost: 1,
    constraints: { hasConstrainedInput: false },
  },
}

describe('withBasePath', () => {
  it('returns the registry unchanged for an empty prefix (identity)', () => {
    expect(withBasePath(REG, '')).toBe(REG)
  })

  it('prefixes every operation path', () => {
    const out = withBasePath(REG, '/api')
    expect(out.ListNotes.path).toBe('/api/notes')
    expect(out.GetNote.path).toBe('/api/notes/:id')
    // does not mutate the input
    expect(REG.ListNotes.path).toBe('/notes')
  })

  it('preserves all non-path metadata', () => {
    const out = withBasePath(REG, '/api')
    expect(out.ListNotes.requiredPermissions).toEqual(['notes.read'])
    expect(out.GetNote.authSchemes).toEqual([{ type: 'oidc' }])
  })

  it('keeps resolveOp matching the live prefixed path (the core guarantee)', () => {
    const resolve = resolveOp(withBasePath(REG, '/api'))
    // The full request path under the prefix resolves to its op...
    expect(resolve('GET', '/api/notes')?.name).toBe('ListNotes')
    expect(resolve('GET', '/api/notes/abc')?.name).toBe('GetNote')
    // ...while the UNPREFIXED path no longer resolves (would-be silent open route).
    expect(resolve('GET', '/notes')).toBeUndefined()
  })
})
