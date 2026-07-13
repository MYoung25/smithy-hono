/**
 * Resource handler integration (§7) over a fake dispatch `app` (FetchLike): proves
 * the protocol wiring end to end — `initialize` advertises the `resources` capability,
 * `resources/templates/list` returns the derived template, `resources/list` dispatches
 * the list op and maps items → resources, `resources/read` of a known uri dispatches
 * the read op and returns `contents`, an unknown uri → -32602, a `!ok` read → -32002.
 * Plus ONE auth case: a protected read with no token → HTTP 401.
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  createMcpHandler,
  type BearerVerifier,
  type FetchLike,
  type McpAuthConfig,
  type McpTool,
  type VerifiedTokenClaims,
} from './index.js'

const schema = z.object({}).strict()

const tools: McpTool[] = [
  {
    op: {
      name: 'GetTask',
      method: 'GET',
      path: '/tasks/:id',
      readonly: true,
      crudVerb: 'read',
      resource: 'Task',
      identifierMembers: ['id'],
      description: 'Fetch a single Task by its id.',
    },
    inputSchema: z.object({ id: z.string() }).strict(),
  },
  {
    op: {
      name: 'ListTasks',
      method: 'GET',
      path: '/tasks',
      readonly: true,
      crudVerb: 'list',
      resource: 'Task',
      identifierMembers: ['id'],
    },
    inputSchema: schema,
  },
]

// A fake router: one task `t1`, plus a `nextToken` to prove the cursor passthrough.
function makeApp(): FetchLike {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)
      if (request.method === 'GET' && url.pathname === '/tasks') {
        return Response.json({ items: [{ id: 't1', title: 'one' }], nextToken: 'next-1' }, { status: 200 })
      }
      const m = /^\/tasks\/(.+)$/.exec(url.pathname)
      if (request.method === 'GET' && m) {
        const id = decodeURIComponent(m[1])
        if (id === 't1') return Response.json({ item: { id, title: 'one' } }, { status: 200 })
        return Response.json({ code: 'TaskNotFound' }, { status: 404 })
      }
      return new Response('not found', { status: 404 })
    },
  }
}

function driver(handler: (r: Request) => Promise<Response>) {
  return (method: string, params?: unknown, token?: string) =>
    handler(
      new Request('http://x/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
    )
}

describe('mcp-core resources handler (§7)', () => {
  const handler = createMcpHandler({ tools, app: makeApp(), info: { name: 'test', version: '0.0.0' } })
  const rpc = driver(handler)

  it('initialize advertises the resources capability', async () => {
    const json = await (await rpc('initialize')).json()
    expect(json.result.capabilities.resources).toEqual({ listChanged: false })
    expect(json.result.capabilities.tools).toBeDefined()
  })

  it('resources/templates/list returns the derived task template', async () => {
    const json = await (await rpc('resources/templates/list')).json()
    expect(json.result.resourceTemplates).toEqual([
      {
        uriTemplate: 'task://{id}',
        name: 'Task',
        description: 'Fetch a single Task by its id.',
        mimeType: 'application/json',
      },
    ])
  })

  it('resources/list dispatches the list op and maps items + surfaces nextCursor', async () => {
    const json = await (await rpc('resources/list')).json()
    expect(json.result.resources).toEqual([
      { uri: 'task://t1', name: 'Task t1', mimeType: 'application/json' },
    ])
    expect(json.result.nextCursor).toBe('next-1')
  })

  it('resources/read of a known uri dispatches the read op and returns contents', async () => {
    const json = await (await rpc('resources/read', { uri: 'task://t1' })).json()
    expect(json.result.contents).toHaveLength(1)
    const [c] = json.result.contents
    expect(c.uri).toBe('task://t1')
    expect(c.mimeType).toBe('application/json')
    expect(JSON.parse(c.text)).toEqual({ item: { id: 't1', title: 'one' } })
  })

  it('resources/read of an unknown scheme → -32602', async () => {
    const json = await (await rpc('resources/read', { uri: 'widget://x' })).json()
    expect(json.error.code).toBe(-32602)
  })

  it('resources/read whose dispatch is !ok → -32002 (resource not found)', async () => {
    const json = await (await rpc('resources/read', { uri: 'task://missing' })).json()
    expect(json.error.code).toBe(-32002)
    expect(json.error.message).toContain('task://missing')
  })

  it('resources: false force-disables resources (no capability, no template)', async () => {
    const off = createMcpHandler({
      tools,
      app: makeApp(),
      info: { name: 'test', version: '0.0.0' },
      resources: false,
    })
    const init = await (await driver(off)('initialize')).json()
    expect(init.result.capabilities.resources).toBeUndefined()
    const tpls = await (await driver(off)('resources/templates/list')).json()
    expect(tpls.result.resourceTemplates).toEqual([])
  })
})

describe('mcp-core resources handler with auth (§7 + §11)', () => {
  const RESOURCE = 'https://x.example.com/mcp'
  const verifier: BearerVerifier = {
    async verify(): Promise<VerifiedTokenClaims> {
      throw new Error('no token presented')
    },
  }
  const auth: McpAuthConfig = {
    resource: RESOURCE,
    authorizationServers: ['https://idp.example.com'],
    verifier,
  }
  const protectedTools: McpTool[] = [
    {
      op: {
        ...tools[0].op,
        authSchemes: [{ type: 'oidc' }],
        requiredPermissions: ['tasks.read'],
      },
      inputSchema: tools[0].inputSchema,
    },
  ]

  it('resources/read of a protected resource with no token → HTTP 401', async () => {
    const handler = createMcpHandler({
      tools: protectedTools,
      app: makeApp(),
      info: { name: 'test', version: '0.0.0' },
      auth,
    })
    const res = await driver(handler)('resources/read', { uri: 'task://t1' })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"')
    expect(res.headers.get('www-authenticate')).toContain('scope="tasks.read"')
  })
})
