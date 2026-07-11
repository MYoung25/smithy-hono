import { describe, it, expect } from 'vitest'
import { resolveOp, type OperationRegistry, type PipelineOperationMeta } from './index.js'

function op(over: Partial<PipelineOperationMeta>): PipelineOperationMeta {
  return {
    name: 'Op',
    method: 'GET',
    path: '/op',
    authSchemes: [{ type: 'anonymous' }],
    readonly: true,
    requiredPermissions: [],
    cost: 1,
    constraints: { hasConstrainedInput: false },
    ...over,
  }
}

describe('resolveOp — per-segment specificity tiebreaker (AUTHZ-02, finding authz-2)', () => {
  it('prefers the pattern whose leading differing segment is static over param, mirroring Hono', () => {
    // `/:a/b` and `/x/:c` tie on static (1) and total (2) segment counts, and a
    // request `/x/b` matches BOTH compiled regexes. Hono's trie prefers the static
    // position-0 segment and dispatches `/x/:c`. Insertion order here would pick
    // `/:a/b` first without the tiebreaker.
    const reg: OperationRegistry = {
      AParamThenStatic: op({ name: 'AParamThenStatic', path: '/:a/b' }),
      XStaticThenParam: op({ name: 'XStaticThenParam', path: '/x/:c' }),
    }
    const resolve = resolveOp(reg)
    expect(resolve('GET', '/x/b')?.name).toBe('XStaticThenParam')
  })

  it('is insertion-order independent for the tie', () => {
    const reg: OperationRegistry = {
      XStaticThenParam: op({ name: 'XStaticThenParam', path: '/x/:c' }),
      AParamThenStatic: op({ name: 'AParamThenStatic', path: '/:a/b' }),
    }
    const resolve = resolveOp(reg)
    expect(resolve('GET', '/x/b')?.name).toBe('XStaticThenParam')
  })
})

describe('resolveOp — greedy/wildcard param (finding: `:name{*}`)', () => {
  it('matches the multi-segment tail for a greedy `:path{*}` label', () => {
    const reg: OperationRegistry = {
      GetFile: op({ name: 'GetFile', path: '/files/:path{*}' }),
    }
    const resolve = resolveOp(reg)
    expect(resolve('GET', '/files/a/b/c')?.name).toBe('GetFile')
    expect(resolve('GET', '/files/single')?.name).toBe('GetFile')
  })

  it('still matches a plain `:name` as a single segment only', () => {
    const reg: OperationRegistry = {
      GetOne: op({ name: 'GetOne', path: '/files/:id' }),
    }
    const resolve = resolveOp(reg)
    expect(resolve('GET', '/files/one')?.name).toBe('GetOne')
    // A plain param does NOT span multiple segments.
    expect(resolve('GET', '/files/a/b')).toBeUndefined()
  })
})
