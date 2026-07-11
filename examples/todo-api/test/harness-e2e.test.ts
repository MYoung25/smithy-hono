/**
 * Integration showcase — the FULL security pipeline driven by the typed client via
 * @smithy-hono/test-kit's `createTestHarness`. One factory call replaces the hand-built
 * makeApp() + four Memory*Store + seedSession() + cookie/CSRF wiring from security-e2e.
 *
 * (The exhaustive per-requirement security matrix still lives in security-e2e.test.ts,
 * which drives raw requests; this proves the kit's harness + loginAs cover the common
 * authenticated flows ergonomically.)
 */
import { describe, it, expect } from 'vitest'
import { createTestHarness, principal, expectError } from '@smithy-hono/test-kit'
import { createTodoRouter, createTodoClient, TodoNotFound, SmithyError, type TodoOperations, type Todo } from '../generated'
import { OPERATIONS } from '../generated/registry.gen'

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
    async ListTodos() { return { items: [...store.values()] } },
    async DeleteTodo({ id }) { if (!store.has(id)) throw new TodoNotFound(`Todo ${id} not found`); store.delete(id) },
  }
}

function harness() {
  return createTestHarness({ operations: OPERATIONS, router: createTodoRouter(makeOps()), createClient: createTodoClient })
}

describe('todo-api through the full pipeline (test-kit harness)', () => {
  it('anonymous client can list (no auth required)', async () => {
    const h = harness()
    expect(await h.client.ListTodos({})).toEqual({ items: [] })
  })

  it('an unauthenticated protected call is rejected (401)', async () => {
    const h = harness()
    expect((await expectError(() => h.client.GetTodo({ id: 'x' }), SmithyError)).$statusCode).toBe(401)
  })

  it('loginAs transparently supplies session cookie + CSRF for a write', async () => {
    const h = harness()
    const { client } = await h.loginAs() // superuser by default
    const { item } = await client.CreateTodo({ body: { title: 'via pipeline' } })
    expect(item.title).toBe('via pipeline')
    // The same authenticated client reads it back.
    expect((await client.GetTodo({ id: item.id })).item).toEqual(item)
  })

  it('a scoped principal lacking todos.write is forbidden (403)', async () => {
    const h = harness()
    const { client } = await h.loginAs(principal({ id: 'reader', permissions: ['todos.read'] }))
    expect((await expectError(() => client.CreateTodo({ body: { title: 'no' } }), SmithyError)).$statusCode).toBe(403)
  })
})
