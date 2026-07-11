/**
 * End-to-end proof of the auth-protected handler (§11): drive `createMcpHandler`
 * with an `auth` config + a fake `BearerVerifier`, over a fake dispatch `app` that
 * asserts the derived principal crossed the trust boundary via `getAttachedPrincipal`.
 * Covers: public discovery (initialize/tools/list) with NO token; a protected
 * `tools/call` → 401 (no token) / 403 (underscoped) / success (sufficient, principal
 * seen); and an anonymous op dispatched with no token and no principal.
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  createMcpHandler,
  getAttachedPrincipal,
  type BearerVerifier,
  type FetchLike,
  type McpAuthConfig,
  type McpPrincipal,
  type McpTool,
  type VerifiedTokenClaims,
} from './index.js'

const RESOURCE = 'https://todo.example.com/mcp'

// A token registry the fake verifier resolves against: maps raw token → scopes.
const TOKENS: Record<string, string[]> = {
  'write-token': ['todos.read', 'todos.write'],
  'read-token': ['todos.read'],
}

const verifier: BearerVerifier = {
  async verify(token: string): Promise<VerifiedTokenClaims> {
    const scopes = TOKENS[token]
    if (!scopes) throw new Error('bad token')
    return { sub: `sub-${token}`, aud: RESOURCE, scopes }
  },
}

const auth: McpAuthConfig = {
  resource: RESOURCE,
  authorizationServers: ['https://idp.example.com'],
  verifier,
}

// Records the principal each dispatched request carried, so a test can assert the
// trust-boundary crossing. A real host would `c.set('principal', …)` instead.
function makeApp(): { app: FetchLike; seen: (McpPrincipal | undefined)[] } {
  const seen: (McpPrincipal | undefined)[] = []
  const app: FetchLike = {
    async fetch(request: Request): Promise<Response> {
      seen.push(getAttachedPrincipal(request) as McpPrincipal | undefined)
      const url = new URL(request.url)
      if (request.method === 'POST' && url.pathname === '/todos') {
        const body = await request.json()
        return Response.json({ item: { id: 't1', ...body } }, { status: 201 })
      }
      if (request.method === 'GET' && url.pathname === '/todos') {
        return Response.json({ items: [] }, { status: 200 })
      }
      return new Response('not found', { status: 404 })
    },
  }
  return { app, seen }
}

const tools: McpTool[] = [
  {
    // Protected: requires the `todos.write` scope.
    op: {
      name: 'CreateTodo',
      method: 'POST',
      path: '/todos',
      crudVerb: 'create',
      resource: 'Todo',
      authSchemes: [{ type: 'oidc' }],
      requiredPermissions: ['todos.write'],
    },
    inputSchema: z.object({ body: z.object({ title: z.string() }).strict() }).strict(),
  },
  {
    // Anonymous: dispatches with no principal even when auth is configured.
    op: {
      name: 'ListTodos',
      method: 'GET',
      path: '/todos',
      crudVerb: 'list',
      resource: 'Todo',
      readonly: true,
      authSchemes: [{ type: 'anonymous' }],
    },
    inputSchema: z.object({}).strict(),
  },
  {
    // HMAC-only (S2S): a bearer token can NOT substitute for it (MCP-CORE-01).
    op: {
      name: 'ImportNotes',
      method: 'POST',
      path: '/todos',
      crudVerb: 'create',
      resource: 'Todo',
      authSchemes: [{ type: 'sigv4Hmac' }],
      requiredPermissions: ['notes.import'],
    },
    inputSchema: z.object({ body: z.object({ title: z.string() }).strict() }).strict(),
  },
  {
    // Non-anonymous (oidc) but ZERO required scopes — must fail closed (MCP-CORE-05).
    op: {
      name: 'OpenTodo',
      method: 'POST',
      path: '/todos',
      crudVerb: 'create',
      resource: 'Todo',
      authSchemes: [{ type: 'oidc' }],
      requiredPermissions: [],
    },
    inputSchema: z.object({ body: z.object({ title: z.string() }).strict() }).strict(),
  },
]

function driver(app: FetchLike) {
  const handler = createMcpHandler({ tools, app, info: { name: 'todo', version: '1.0.0' }, auth })
  return (method: string, params?: unknown, token?: string) =>
    handler(
      new Request('https://todo.example.com/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
    )
}

describe('createMcpHandler with auth (§11)', () => {
  it('initialize works with NO token (public)', async () => {
    const { app } = makeApp()
    const res = await driver(app)('initialize', { protocolVersion: '2025-06-18' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.result.serverInfo).toEqual({ name: 'todo', version: '1.0.0' })
  })

  it('tools/list works with NO token (public)', async () => {
    const { app } = makeApp()
    const res = await driver(app)('tools/list')
    const json = await res.json()
    expect((json.result.tools as { name: string }[]).map((t) => t.name).sort()).toEqual([
      'CreateTodo',
      'ImportNotes',
      'ListTodos',
      'OpenTodo',
    ])
  })

  it('protected tools/call with NO token → 401 + WWW-Authenticate', async () => {
    const { app, seen } = makeApp()
    const res = await driver(app)('tools/call', {
      name: 'CreateTodo',
      arguments: { body: { title: 'x' } },
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"')
    expect(res.headers.get('www-authenticate')).toContain('scope="todos.write"')
    expect(seen).toHaveLength(0) // never dispatched
  })

  it('protected tools/call with an underscoped token → 403', async () => {
    const { app, seen } = makeApp()
    const res = await driver(app)(
      'tools/call',
      { name: 'CreateTodo', arguments: { body: { title: 'x' } } },
      'read-token',
    )
    expect(res.status).toBe(403)
    expect(res.headers.get('www-authenticate')).toContain('error="insufficient_scope"')
    expect(seen).toHaveLength(0)
  })

  it('protected tools/call with a sufficient token → success AND principal injected', async () => {
    const { app, seen } = makeApp()
    const res = await driver(app)(
      'tools/call',
      { name: 'CreateTodo', arguments: { body: { title: 'hi' } } },
      'write-token',
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.result.isError).toBeFalsy()
    expect(json.result.structuredContent.item.title).toBe('hi')
    // The dispatch saw the derived principal — not the raw token.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({
      id: 'sub-write-token',
      permissions: ['todos.read', 'todos.write'],
      claims: { sub: 'sub-write-token', aud: RESOURCE, scopes: ['todos.read', 'todos.write'] },
      kind: 'user',
    })
  })

  it('anonymous tools/call succeeds with no token and no principal attached', async () => {
    const { app, seen } = makeApp()
    const res = await driver(app)('tools/call', { name: 'ListTodos', arguments: {} })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.result.isError).toBeFalsy()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeUndefined()
  })

  it('HMAC-only op is a hard 403, never dispatched, even with a valid token (MCP-CORE-01)', async () => {
    const { app, seen } = makeApp()
    const res = await driver(app)(
      'tools/call',
      { name: 'ImportNotes', arguments: { body: { title: 'x' } } },
      'write-token',
    )
    expect(res.status).toBe(403)
    // Not an OAuth challenge: no scope is acquirable to satisfy it.
    expect(res.headers.get('www-authenticate')).toBeNull()
    expect(seen).toHaveLength(0) // never dispatched — no auth-scheme downgrade
  })

  it('non-anonymous op with EMPTY required scopes fails closed (MCP-CORE-05)', async () => {
    const { app, seen } = makeApp()
    const res = await driver(app)(
      'tools/call',
      { name: 'OpenTodo', arguments: { body: { title: 'x' } } },
      'write-token',
    )
    expect(res.status).toBe(403)
    expect(seen).toHaveLength(0) // any-authenticated-user must NOT pass vacuously
  })

  it('a batch aborts BEFORE dispatching earlier members when a later member 403s (MCP-CORE-02)', async () => {
    const { app, seen } = makeApp()
    const handler = createMcpHandler({
      tools,
      app,
      info: { name: 'todo', version: '1.0.0' },
      auth,
    })
    // First member would mutate (CreateTodo, authorized by write-token); second member
    // is HMAC-only → would 403. The whole POST must short-circuit with NO dispatch.
    const res = await handler(
      new Request(RESOURCE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer write-token' },
        body: JSON.stringify([
          { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'CreateTodo', arguments: { body: { title: 'a' } } } },
          { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ImportNotes', arguments: { body: { title: 'b' } } } },
        ]),
      }),
    )
    expect(res.status).toBe(403)
    expect(seen).toHaveLength(0) // earlier mutating member never ran
  })
})
