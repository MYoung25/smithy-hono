/**
 * Handler/router behavior — MIGRATED to @smithy-hono/test-kit.
 *
 * Before: hand-rolled makeApp() with a principal stand-in middleware, raw
 * app.request(method/headers/JSON.stringify), and `(await res.json()).code` asserts.
 * After: `mountRouter` gives a typed client wired to the router in-process; the typed
 * client drives happy-path + typed-error cases; raw `app.request` is kept only for the
 * malformed-input cases the typed client can't express (bad JSON, missing required field).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mountRouter, expectError } from '@smithy-hono/test-kit'
import {
  createTodoRouter,
  createTodoClient,
  TodoNotFound,
  ValidationError,
  SmithyError,
  type TodoClient,
  type TodoOperations,
  type Todo,
} from '../generated'
import { OPERATIONS } from '../generated/registry.gen'
import { Hono } from 'hono'

// Predictable in-memory implementation for test isolation.
function makeOps(overrides: Partial<TodoOperations> = {}) {
  const store = new Map<string, Todo>()
  let seq = 0
  const ops: TodoOperations = {
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
    async DeleteTodo({ id }) {
      if (!store.has(id)) throw new TodoNotFound(`Todo ${id} not found`)
      store.delete(id)
    },
    ...overrides,
  }
  return ops
}

// One line replaces the old makeApp() + principal-stand-in middleware + manual client.
function setup(overrides: Partial<TodoOperations> = {}): { client: TodoClient; app: Hono } {
  const { app, client } = mountRouter({
    router: createTodoRouter(makeOps(overrides)),
    createClient: createTodoClient,
    operations: OPERATIONS, // default principal is a superuser → reaches every route
  })
  return { client, app }
}

// ── ListTodos ──────────────────────────────────────────────────────────────────

describe('ListTodos', () => {
  it('returns an empty list when no todos exist', async () => {
    const { client } = setup()
    expect(await client.ListTodos({})).toEqual({ items: [] })
  })

  it('returns all created todos', async () => {
    const { client } = setup()
    await client.CreateTodo({ body: { title: 'First' } })
    await client.CreateTodo({ body: { title: 'Second' } })
    const page = await client.ListTodos({})
    expect(page.items.map(t => t.title)).toEqual(['First', 'Second'])
  })

  it('forwards nextToken to the handler', async () => {
    const received: string[] = []
    const { client } = setup({ async ListTodos({ nextToken }) { if (nextToken) received.push(nextToken); return { items: [] } } })
    await client.ListTodos({ nextToken: 'cursor-abc' })
    expect(received).toEqual(['cursor-abc'])
  })

  it('maps a handler ValidationError to the typed error', async () => {
    const { client } = setup({ async ListTodos() { throw new ValidationError('bad filter') } })
    const err = await expectError(() => client.ListTodos({}), ValidationError)
    expect(err.$statusCode).toBe(400)
  })
})

// ── GetTodo ───────────────────────────────────────────────────────────────────

describe('GetTodo', () => {
  let client: TodoClient
  beforeEach(() => { client = setup().client })

  it('returns the todo when it exists', async () => {
    const { item } = await client.CreateTodo({ body: { title: 'Test' } })
    const got = await client.GetTodo({ id: item.id })
    expect(got.item.id).toBe(item.id)
    expect(got.item.title).toBe('Test')
    expect(got.item.done).toBe(false)
  })

  it('throws TodoNotFound (404) when the todo is missing', async () => {
    const err = await expectError(() => client.GetTodo({ id: 'does-not-exist' }), TodoNotFound)
    expect(err.$statusCode).toBe(404)
  })

  it('surfaces an unexpected handler error as a 500 SmithyError', async () => {
    const c = setup({ async GetTodo() { throw new Error('db connection failed') } }).client
    const err = await expectError(() => c.GetTodo({ id: 'any' }), SmithyError)
    expect(err.$statusCode).toBe(500)
  })
})

// ── CreateTodo ────────────────────────────────────────────────────────────────

describe('CreateTodo', () => {
  it('creates a todo (201) with defaults', async () => {
    const { client } = setup()
    const { item } = await client.CreateTodo({ body: { title: 'Buy milk' } })
    expect(item.title).toBe('Buy milk')
    expect(item.done).toBe(false)
    expect(typeof item.id).toBe('string')
  })

  it('passes done=true through', async () => {
    const { client } = setup()
    const { item } = await client.CreateTodo({ body: { title: 'Done', done: true } })
    expect(item.done).toBe(true)
  })

  it('rejects a missing required title with a 400 ValidationException (raw request)', async () => {
    // The typed client can't express an invalid body; assert the generated validator
    // via a raw request through the same app the client uses.
    const { app } = setup()
    const res = await app.request('/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ done: false }),
    })
    expect(res.status).toBe(400)
    expect((await res.json() as { code: string }).code).toBe('ValidationException')
  })

  it('rejects a non-JSON body with 400 (raw request)', async () => {
    const { app } = setup()
    const res = await app.request('/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    })
    expect(res.status).toBe(400)
  })
})

// ── DeleteTodo ────────────────────────────────────────────────────────────────

describe('DeleteTodo', () => {
  it('deletes (204) and a subsequent get throws TodoNotFound', async () => {
    const { client } = setup()
    const { item } = await client.CreateTodo({ body: { title: 'ephemeral' } })
    await expect(client.DeleteTodo({ id: item.id })).resolves.toBeUndefined()
    await expectError(() => client.GetTodo({ id: item.id }), TodoNotFound)
  })

  it('throws TodoNotFound when the todo does not exist', async () => {
    const { client } = setup()
    await expectError(() => client.DeleteTodo({ id: 'ghost' }), TodoNotFound)
  })
})
