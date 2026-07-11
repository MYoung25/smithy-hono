/**
 * Router authorization model — MIGRATED to @smithy-hono/test-kit.
 *
 * `mountRouter` stands in for the pipeline's `authenticate` phase: pass a principal to
 * set on the context (or `null` for an unauthenticated request). The generated client
 * maps the authorize hook's non-modeled `{code:'Unauthorized'|'AccessDenied'}` responses
 * to a `SmithyError` carrying the status, so we assert on `$statusCode`.
 */
import { describe, it, expect } from 'vitest'
import { mountRouter, principal, expectError } from '@smithy-hono/test-kit'
import type { Principal } from '@smithy-hono/security-core'
import {
  createTodoRouter,
  createTodoClient,
  TodoNotFound,
  SmithyError,
  type TodoOperations,
  type Todo,
} from '../generated'

function makeOps(): TodoOperations {
  const store = new Map<string, Todo>()
  let seq = 0
  return {
    async CreateTodo({ body }) {
      const todo: Todo = { id: `id-${++seq}`, title: body.title, done: body.done ?? false, createdAt: '2024-01-01T00:00:00.000Z' }
      store.set(todo.id, todo)
      return { item: todo }
    },
    async GetTodo({ id }) {
      const todo = store.get(id)
      if (!todo) throw new TodoNotFound(`Todo ${id} not found`)
      return { item: todo }
    },
    async ListTodos() { return { items: [] } },
    async DeleteTodo() {},
  }
}

function clientWith(p: Principal | null) {
  return mountRouter({ router: createTodoRouter(makeOps()), createClient: createTodoClient, principal: p }).client
}

describe('no principal → 401 Unauthorized', () => {
  const client = () => clientWith(null)
  it('GetTodo → 401', async () => {
    expect((await expectError(() => client().GetTodo({ id: 'x' }), SmithyError)).$statusCode).toBe(401)
  })
  it('CreateTodo → 401', async () => {
    expect((await expectError(() => client().CreateTodo({ body: { title: 't' } }), SmithyError)).$statusCode).toBe(401)
  })
  it('DeleteTodo → 401', async () => {
    expect((await expectError(() => client().DeleteTodo({ id: 'x' }), SmithyError)).$statusCode).toBe(401)
  })
})

describe('principal missing the permission → 403 AccessDenied', () => {
  const readOnly = () => clientWith(principal({ id: 'u', permissions: ['todos.read'] }))
  it('CreateTodo with only todos.read → 403', async () => {
    expect((await expectError(() => readOnly().CreateTodo({ body: { title: 't' } }), SmithyError)).$statusCode).toBe(403)
  })
  it('DeleteTodo with only todos.read → 403', async () => {
    expect((await expectError(() => readOnly().DeleteTodo({ id: 'x' }), SmithyError)).$statusCode).toBe(403)
  })
})

describe('principal with the permission → handler runs', () => {
  it('CreateTodo with todos.write → 201', async () => {
    const c = clientWith(principal({ permissions: ['todos.write'] }))
    expect((await c.CreateTodo({ body: { title: 't' } })).item.title).toBe('t')
  })
  it('GetTodo with todos.read reaches the handler (404 proves the gate passed)', async () => {
    const c = clientWith(principal({ permissions: ['todos.read'] }))
    await expectError(() => c.GetTodo({ id: 'missing' }), TodoNotFound)
  })
})

describe('anonymous route needs no principal', () => {
  it('ListTodos works with NO principal', async () => {
    expect(await clientWith(null).ListTodos({})).toEqual({ items: [] })
  })
})
