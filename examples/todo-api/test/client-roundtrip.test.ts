/**
 * Proves the GENERATED typed client (todo.client.gen.ts) speaks the same wire
 * contract as the GENERATED router (todo.gen.ts) — they're emitted by the same
 * plugin, so they must agree by construction. Every call goes through Hono's
 * in-memory transport (`app.request.bind(app)`), no network.
 *
 * This is the canary for Part A: any binding/serde mismatch (path, query, body,
 * status, ISO timestamp, typed-error mapping) fails here.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { SecurityEnv } from '@smithy-hono/security-core'
import {
  createTodoRouter,
  createTodoClient,
  TodoNotFound,
  type TodoClient,
  type TodoOperations,
  type Todo,
} from '../generated'

// In-memory ops (mirrors behavior.test.ts).
function makeOps(): TodoOperations {
  const store = new Map<string, Todo>()
  let seq = 0
  return {
    async CreateTodo({ body }) {
      const todo: Todo = {
        id: `id-${++seq}`,
        title: body.title,
        done: body.done ?? false,
        createdAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
      }
      store.set(todo.id, todo)
      return { item: todo }
    },
    async GetTodo({ id }) {
      const todo = store.get(id)
      if (!todo) throw new TodoNotFound(`Todo ${id} not found`)
      return { item: todo }
    },
    async ListTodos() {
      return { items: [...store.values()] }
    },
    async DeleteTodo({ id }) {
      if (!store.has(id)) throw new TodoNotFound(`Todo ${id} not found`)
      store.delete(id)
    },
  }
}

// Mount the real router with a fully-permissioned principal stand-in (authenticate's job).
function makeClient(): TodoClient {
  const app = new Hono<SecurityEnv>()
  app.use('*', async (c, next) => {
    c.set('principal', { id: 'test-user', permissions: ['todos.read', 'todos.write'], claims: {}, kind: 'user' })
    await next()
  })
  app.route('/', createTodoRouter(makeOps()))
  return createTodoClient({ fetch: app.request.bind(app) })
}

describe('generated client ↔ generated router round-trip', () => {
  let client: TodoClient
  beforeEach(() => { client = makeClient() })

  it('CreateTodo (POST 201, payload body) → GetTodo (GET 200, :id path) round-trips', async () => {
    const created = await client.CreateTodo({ body: { title: 'write the client' } })
    expect(created.item.title).toBe('write the client')
    expect(created.item.done).toBe(false)
    // ISO-8601 string passes through verbatim (not epoch).
    expect(typeof created.item.createdAt).toBe('string')
    expect(() => new Date(created.item.createdAt).toISOString()).not.toThrow()

    const got = await client.GetTodo({ id: created.item.id })
    expect(got.item).toEqual(created.item)
  })

  it('ListTodos (query binding) returns created items', async () => {
    await client.CreateTodo({ body: { title: 'a' } })
    await client.CreateTodo({ body: { title: 'b' } })
    const page = await client.ListTodos({})
    expect(page.items.map(t => t.title)).toEqual(['a', 'b'])
  })

  it('a 404 is reconstructed as the generated typed error class', async () => {
    await expect(client.GetTodo({ id: 'nope' })).rejects.toBeInstanceOf(TodoNotFound)
  })

  it('DeleteTodo (204) resolves to undefined and removes the todo', async () => {
    const { item } = await client.CreateTodo({ body: { title: 'ephemeral' } })
    await expect(client.DeleteTodo({ id: item.id })).resolves.toBeUndefined()
    await expect(client.GetTodo({ id: item.id })).rejects.toBeInstanceOf(TodoNotFound)
  })

  it('baseUrl + injected fetch build an absolute URL for the prod path', async () => {
    let seenUrl = ''
    const stub: typeof fetch = async (input) => {
      seenUrl = String(input)
      return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const c = createTodoClient({ baseUrl: 'https://api.example.com', fetch: stub })
    await c.ListTodos({ nextToken: 'cur sor' })
    expect(seenUrl).toBe('https://api.example.com/todos?nextToken=cur+sor')
  })
})
