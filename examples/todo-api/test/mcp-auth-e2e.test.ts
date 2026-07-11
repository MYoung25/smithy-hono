/**
 * MCP auth e2e (Plan 14 §11.8) — drives the LIVE OAuth-protected `/mcp` mount that
 * `createTodoMcpApp` assembles over the REAL generated todo-api router + the real
 * security pipeline. Proves the phase-2 resource-server contract end to end:
 *
 *   • public discovery — `tools/list` + the PRM document need no token.
 *   • protected `tools/call` with NO token → HTTP 401 + `WWW-Authenticate: Bearer …`.
 *   • token lacking the scope → HTTP 403 `insufficient_scope`.
 *   • token WITH the scope → dispatch runs with the injected principal so the
 *     generated `authorize` hook passes and the create round-trips.
 *   • the anonymous op (`ListTodos`) succeeds with NO token.
 *
 * The bearer verifier is a FAKE (no network): a fixed token→claims map, so the test
 * is deterministic and exercises mcp-core's verify/scope/dispatch path, not jose.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createMcpClient, type McpClient } from '@smithy-hono/test-kit'
import type { BearerVerifier, VerifiedTokenClaims } from '@smithy-hono/mcp-core'
import { createTodoMcpApp } from '../src/mcpAuth'
import { TodoNotFound, type Todo, type TodoOperations } from '../generated/todo.gen'

const RESOURCE = 'https://todo.example.com/mcp'
const ISSUER = 'https://idp.example.com'

// ── Fixed test tokens → claims (the fake verifier's map) ──────────────────────
// `writer` carries todos.read + todos.write; `reader` only todos.read; anything
// else is unknown → verify() throws (mcp-core treats that as unauthenticated).
const TOKENS: Record<string, VerifiedTokenClaims> = {
  writer: { sub: 'u-writer', iss: ISSUER, aud: RESOURCE, exp: 9_999_999_999, scopes: ['todos.read', 'todos.write'] },
  reader: { sub: 'u-reader', iss: ISSUER, aud: RESOURCE, exp: 9_999_999_999, scopes: ['todos.read'] },
}

const fakeVerifier: BearerVerifier = {
  async verify(token) {
    const claims = TOKENS[token]
    if (!claims) throw new Error('invalid token')
    return claims
  },
}

// ── Fresh in-memory ops per test (mirrors security-e2e.test.ts) ───────────────
function makeOps(): TodoOperations {
  const store = new Map<string, Todo>()
  let seq = 0
  return {
    async CreateTodo({ body }) {
      const todo: Todo = {
        id: `id-${++seq}`,
        title: body.title,
        done: body.done ?? false,
        createdAt: '2024-01-01T00:00:00.000Z',
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

describe('todo-api MCP bridge — OAuth 2.1 resource server (live /mcp mount)', () => {
  let app: ReturnType<typeof createTodoMcpApp>
  let mcp: McpClient

  beforeEach(() => {
    app = createTodoMcpApp({
      resource: RESOURCE,
      authorizationServers: [ISSUER],
      verifier: fakeVerifier,
      ops: makeOps(),
    })
    // The test-kit MCP client collapses the JSON-RPC envelope + bearer + forwarded-proto
    // boilerplate into listTools()/callTool(name, args, { token }).
    mcp = createMcpClient(app)
  })

  it('tools/list is public discovery — no token required', async () => {
    const { status, result } = await mcp.listTools()
    expect(status).toBe(200)
    const names = (result.tools as Array<{ name: string }>).map((t) => t.name).sort()
    expect(names).toEqual(['CreateTodo', 'DeleteTodo', 'GetTodo', 'ListTodos'])
  })

  it('protected tools/call (CreateTodo) with NO token → 401 + WWW-Authenticate', async () => {
    const { res } = await mcp.callTool('CreateTodo', { body: { title: 'no token', done: false } })
    expect(res.status).toBe(401)
    const challenge = res.headers.get('www-authenticate')
    expect(challenge).toMatch(/^Bearer /)
    expect(challenge).toContain('resource_metadata=')
  })

  it('tools/call with a token LACKING todos.write → 403 insufficient_scope', async () => {
    const { res } = await mcp.callTool('CreateTodo', { body: { title: 'reader cannot write' } }, { token: 'reader' })
    expect(res.status).toBe(403)
    expect(res.headers.get('www-authenticate')).toContain('error="insufficient_scope"')
  })

  it('tools/call with a SUFFICIENT token → success, and the create round-trips', async () => {
    const created = await mcp.callTool('CreateTodo', { body: { title: 'via mcp', done: false } }, { token: 'writer' })
    expect(created.status).toBe(200)
    const item = created.result.structuredContent.item as { id: string; title: string }
    expect(item.title).toBe('via mcp')

    // The dispatch ran with the injected principal (todos.write) so `authorize`
    // passed; the item is now readable back with a todos.read token.
    const got = await mcp.callTool('GetTodo', { id: item.id }, { token: 'reader' })
    expect(got.status).toBe(200)
    expect(got.result.structuredContent.item.id).toBe(item.id)
  })

  it('the anonymous op (ListTodos) succeeds with NO token', async () => {
    const { status, result } = await mcp.callTool('ListTodos', {})
    expect(status).toBe(200)
    expect(result.isError).toBeFalsy()
    expect(Array.isArray(result.structuredContent.items)).toBe(true)
  })

  it('GET /.well-known/oauth-protected-resource returns the PRM JSON', async () => {
    const res = await app.request('/.well-known/oauth-protected-resource', {
      headers: { 'x-forwarded-proto': 'https' },
    })
    expect(res.status).toBe(200)
    const prm = (await res.json()) as { resource: string; authorization_servers: string[] }
    expect(prm.resource).toBe(RESOURCE)
    expect(prm.authorization_servers).toEqual([ISSUER])
  })
})
