import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { authorize } from './authorize.js'
import type { AuthorizableOperation } from './authorize.js'
import type { SecurityEnv } from './context.js'
import type { Principal } from '../storage/index.js'

const WRITE_OP: AuthorizableOperation = {
  name: 'CreateTodo',
  requiredPermissions: ['todos.write'],
}

const MULTI_OP: AuthorizableOperation = {
  name: 'AdminThing',
  requiredPermissions: ['todos.write', 'todos.admin'],
}

function principal(
  permissions: string[],
  kind: Principal['kind'] = 'user',
): Principal {
  return { id: 'user-1', permissions, claims: {}, kind }
}

/** Build an app where a test-injected principal is set before `authorize` runs. */
function appWith(p: Principal | undefined, op: AuthorizableOperation): Hono<SecurityEnv> {
  const app = new Hono<SecurityEnv>()
  app.post(
    '/todos',
    async (c, next) => {
      if (p) c.set('principal', p)
      await next()
    },
    authorize(op),
    (c) => c.json({ ok: true }, 201),
  )
  return app
}

describe('authorize — operation-tier permission check', () => {
  it('allows when the principal holds every required permission', async () => {
    const res = await appWith(principal(['todos.write']), WRITE_OP).request('/todos', {
      method: 'POST',
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('allows when the principal holds a superset of required permissions', async () => {
    const res = await appWith(
      principal(['todos.read', 'todos.write', 'todos.admin']),
      WRITE_OP,
    ).request('/todos', { method: 'POST' })
    expect(res.status).toBe(201)
  })

  it('denies with 403 AccessDenied when a required permission is missing', async () => {
    const res = await appWith(principal(['todos.read']), WRITE_OP).request('/todos', {
      method: 'POST',
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ code: 'AccessDenied' })
  })

  it('requires ALL permissions for a multi-permission op', async () => {
    const res = await appWith(principal(['todos.write']), MULTI_OP).request('/todos', {
      method: 'POST',
    })
    expect(res.status).toBe(403)
  })

  it('401s when no principal is on the context (auth never ran / failed)', async () => {
    const res = await appWith(undefined, WRITE_OP).request('/todos', { method: 'POST' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ code: 'Unauthorized' })
  })

  it('allows any principal for an op with no required permissions', async () => {
    const noPermOp: AuthorizableOperation = { name: 'ListTodos', requiredPermissions: [] }
    const res = await appWith(principal([]), noPermOp).request('/todos', {
      method: 'POST',
    })
    expect(res.status).toBe(201)
  })

  it('still 401s an op with no permissions when there is no principal', async () => {
    const noPermOp: AuthorizableOperation = { name: 'ListTodos', requiredPermissions: [] }
    const res = await appWith(undefined, noPermOp).request('/todos', { method: 'POST' })
    expect(res.status).toBe(401)
  })
})

describe('authorize — allowedPrincipalKinds (AUTHZ-03)', () => {
  const userOnlyOp: AuthorizableOperation = {
    name: 'CreateTodo',
    requiredPermissions: ['todos.write'],
    allowedPrincipalKinds: ['user'],
  }

  it('allows a principal whose kind is in the allow-list', async () => {
    const res = await appWith(principal(['todos.write'], 'user'), userOnlyOp).request(
      '/todos',
      { method: 'POST' },
    )
    expect(res.status).toBe(201)
  })

  it('denies with 403 a principal whose kind is NOT allowed, even with the permission', async () => {
    const res = await appWith(principal(['todos.write'], 'service'), userOnlyOp).request(
      '/todos',
      { method: 'POST' },
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ code: 'AccessDenied' })
  })

  it('still 401s a disallowed-kind request when there is no principal at all', async () => {
    const res = await appWith(undefined, userOnlyOp).request('/todos', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('absent allow-list imposes no kind restriction (non-breaking default)', async () => {
    const anyKindOp: AuthorizableOperation = {
      name: 'CreateTodo',
      requiredPermissions: ['todos.write'],
    }
    const res = await appWith(principal(['todos.write'], 'service'), anyKindOp).request(
      '/todos',
      { method: 'POST' },
    )
    expect(res.status).toBe(201)
  })
})
