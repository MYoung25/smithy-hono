import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import { createSecurityPipeline, resolveOp } from './index.js'
import type { OperationRegistry, PipelineConfig } from './index.js'

// A minimal registry mirroring the codegen-emitted `OPERATIONS` shape.
const OPERATIONS: OperationRegistry = {
  CreateTodo: {
    name: 'CreateTodo',
    method: 'POST',
    path: '/todos',
    authSchemes: [{ type: 'oidc' }],
    readonly: false,
    requiredPermissions: ['todos.write'],
    cost: 1,
    constraints: { hasConstrainedInput: false },
  },
  GetTodo: {
    name: 'GetTodo',
    method: 'GET',
    path: '/todos/:id',
    authSchemes: [{ type: 'oidc' }],
    readonly: true,
    requiredPermissions: ['todos.read'],
    cost: 1,
    constraints: { hasConstrainedInput: false },
  },
  ListTodos: {
    name: 'ListTodos',
    method: 'GET',
    path: '/todos',
    authSchemes: [{ type: 'anonymous' }],
    readonly: true,
    requiredPermissions: [],
    cost: 1,
    constraints: { hasConstrainedInput: false },
  },
}

function makeConfig(): PipelineConfig {
  return {
    allowedOrigins: ['https://app.example.com'],
    hsts: { maxAge: 31536000, includeSubDomains: true },
    idleTtlSeconds: 900,
    stores: {},
    // S3/S4/S7 fields the implemented phases require:
    forwardedProtoHeader: () => 'https',
    maxBodyBytes: 1_000_000,
    protocolContentType: 'application/json',
    clientIp: () => '127.0.0.1',
  }
}

// All twelve slots are now real implementations, each with its own dedicated
// test suite — no named pass-throughs remain (verifySignature, the last, landed
// in S6). This file asserts only the composition: exact ordering, the OPTIONS
// short-circuit slot, reachability, and unknown-route behavior.

// The canonical order from 00-overview.md / 03-pipeline-ordering.md. Each phase
// is implemented as a *named* function, so we can assert on `handler.name`.
const CANONICAL_ORDER = [
  'requestId',
  'structuredLogger',
  'errorSanitizer',
  'securityHeaders',
  'assertHttps',
  'cors',
  'headerGuards',
  'rateLimitPerIp',
  'bodyGuards',
  'authenticate',
  'verifySignature',
  'csrf',
  'rateLimitPerPrincipal',
]

describe('createSecurityPipeline — canonical ordering', () => {
  it('returns the canonical phases in order (body work split per PIPELINE-MW-01)', () => {
    const pipeline = createSecurityPipeline(OPERATIONS, makeConfig())
    expect(pipeline.map((h) => h.name)).toEqual(CANONICAL_ORDER)
  })

  it('runs the cheap headerGuards BEFORE the per-IP limiter and bodyGuards AFTER it (PIPELINE-MW-01)', () => {
    const names = createSecurityPipeline(OPERATIONS, makeConfig()).map((h) => h.name)
    expect(names.indexOf('headerGuards')).toBeLessThan(names.indexOf('rateLimitPerIp'))
    expect(names.indexOf('rateLimitPerIp')).toBeLessThan(names.indexOf('bodyGuards'))
    // The expensive body stage still precedes authenticate/verifySignature, which
    // consume the bounded body.
    expect(names.indexOf('bodyGuards')).toBeLessThan(names.indexOf('authenticate'))
    expect(names.indexOf('bodyGuards')).toBeLessThan(names.indexOf('verifySignature'))
  })

  it('places authenticate after cors (OPTIONS short-circuit slot) and before csrf', () => {
    const names = createSecurityPipeline(OPERATIONS, makeConfig()).map((h) => h.name)
    expect(names.indexOf('cors')).toBeLessThan(names.indexOf('authenticate'))
    expect(names.indexOf('authenticate')).toBeLessThan(names.indexOf('csrf'))
    expect(names.indexOf('rateLimitPerIp')).toBeLessThan(names.indexOf('authenticate'))
    expect(names.indexOf('authenticate')).toBeLessThan(
      names.indexOf('rateLimitPerPrincipal'),
    )
  })

  it('omits the timeout/load-shed slots by default (OPS-04 opt-in)', () => {
    const names = createSecurityPipeline(OPERATIONS, makeConfig()).map((h) => h.name)
    expect(names).not.toContain('withTimeout')
    expect(names).not.toContain('loadShedder')
  })

  it('inserts loadShedder + withTimeout after cors and before bodyGuards when configured (OPS-04)', () => {
    const names = createSecurityPipeline(OPERATIONS, {
      ...makeConfig(),
      maxInFlight: 100,
      requestTimeoutMs: 5000,
    }).map((h) => h.name)
    expect(names).toContain('loadShedder')
    expect(names).toContain('withTimeout')
    // Mounted after the OPTIONS short-circuit, before the heavy body phase.
    expect(names.indexOf('cors')).toBeLessThan(names.indexOf('loadShedder'))
    expect(names.indexOf('loadShedder')).toBeLessThan(names.indexOf('withTimeout'))
    expect(names.indexOf('withTimeout')).toBeLessThan(names.indexOf('bodyGuards'))
  })
})

describe('createSecurityPipeline — OPS-04 disabled warning (PIPELINE-MW-02)', () => {
  it('warns once per unset DoS guard at construction time when a logger is injected', () => {
    const calls: Array<Record<string, unknown>> = []
    createSecurityPipeline(OPERATIONS, {
      ...makeConfig(),
      logger: {
        info() {},
        warn: (entry: Record<string, unknown>) => calls.push(entry),
        error() {},
      },
    } as PipelineConfig)
    const ops04 = calls.filter((c) => c.event === 'ops04.disabled')
    expect(ops04.map((c) => c.guard).sort()).toEqual(['loadShedder', 'withTimeout'])
  })

  it('does NOT warn for a guard that IS configured', () => {
    const calls: Array<Record<string, unknown>> = []
    createSecurityPipeline(OPERATIONS, {
      ...makeConfig(),
      maxInFlight: 100,
      logger: {
        info() {},
        warn: (entry: Record<string, unknown>) => calls.push(entry),
        error() {},
      },
    } as PipelineConfig)
    const guards = calls.filter((c) => c.event === 'ops04.disabled').map((c) => c.guard)
    expect(guards).not.toContain('loadShedder')
    expect(guards).toContain('withTimeout')
  })

  it('is silent when no logger is injected (no throw)', () => {
    expect(() => createSecurityPipeline(OPERATIONS, makeConfig())).not.toThrow()
  })
})

describe('createSecurityPipeline — reachability', () => {
  it('lets an anonymous route reach the handler unmodified', async () => {
    // ListTodos (GET /todos) is anonymous, so `authenticate` bypasses it and the
    // request reaches the handler. (Authed routes now 401 without a session —
    // covered by authenticate.test.ts.)
    const app = new Hono()
    app.use('*', ...createSecurityPipeline(OPERATIONS, makeConfig()))
    app.get('/todos', (c) => c.json({ items: [] }, 200))

    const res = await app.request('/todos')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ items: [] })
  })
})

describe('createSecurityPipeline — unknown routes', () => {
  it('still runs the generic guards then lets Hono 404', async () => {
    const order: string[] = []
    const app = new Hono()
    // Wrap each phase so we can observe it ran even on an unmatched route.
    const wrapped: MiddlewareHandler[] = createSecurityPipeline(
      OPERATIONS,
      makeConfig(),
    ).map((phase) => async (c, next) => {
      order.push(phase.name)
      await phase(c, next)
    })
    app.use('*', ...wrapped)
    app.get('/todos', (c) => c.json({ items: [] }))

    const res = await app.request('/does-not-exist')
    expect(res.status).toBe(404)
    // Generic guards still executed even though no operation matched.
    expect(order).toEqual(CANONICAL_ORDER)
  })
})

describe('resolveOp', () => {
  const resolve = resolveOp(OPERATIONS)

  it('matches a static path', () => {
    expect(resolve('POST', '/todos')?.name).toBe('CreateTodo')
  })

  it('matches a param path against a concrete segment', () => {
    expect(resolve('GET', '/todos/123')?.name).toBe('GetTodo')
  })

  it('disambiguates by method on the same static path', () => {
    expect(resolve('GET', '/todos')?.name).toBe('ListTodos')
    expect(resolve('POST', '/todos')?.name).toBe('CreateTodo')
  })

  it('is case-insensitive on method', () => {
    expect(resolve('get', '/todos/9')?.name).toBe('GetTodo')
  })

  it('returns undefined for an unknown route', () => {
    expect(resolve('GET', '/nope')).toBeUndefined()
    expect(resolve('DELETE', '/todos/1')).toBeUndefined()
  })

  it('does not match a param segment across a slash', () => {
    expect(resolve('GET', '/todos/1/2')).toBeUndefined()
  })
})

describe('resolveOp — overlapping static vs param routes (AUTHZ-02)', () => {
  // The param op is declared FIRST in registry order so a naive insertion-order
  // first-match would (wrongly) resolve `/todos/search` to SearchById. The sort
  // must make the static op win, mirroring Hono's static > param priority.
  const OVERLAP: OperationRegistry = {
    SearchById: {
      name: 'SearchById',
      method: 'GET',
      path: '/todos/:id',
      authSchemes: [{ type: 'oidc' }],
      readonly: true,
      requiredPermissions: ['todos.read'],
      cost: 1,
      constraints: { hasConstrainedInput: false },
    },
    SearchTodos: {
      name: 'SearchTodos',
      method: 'GET',
      path: '/todos/search',
      authSchemes: [{ type: 'anonymous' }],
      readonly: true,
      requiredPermissions: [],
      cost: 1,
      constraints: { hasConstrainedInput: false },
    },
  }
  const resolve = resolveOp(OVERLAP)

  it('resolves the static route even when the param route is registered first', () => {
    expect(resolve('GET', '/todos/search')?.name).toBe('SearchTodos')
  })

  it('still resolves a non-matching concrete segment to the param route', () => {
    expect(resolve('GET', '/todos/123')?.name).toBe('SearchById')
  })

  it('uses a STRICT end anchor — a trailing slash does NOT match (mirrors Hono)', () => {
    expect(resolve('GET', '/todos/123/')).toBeUndefined()
    expect(resolve('GET', '/todos/search/')).toBeUndefined()
  })
})
