/**
 * Bridge proof: a minimal Hono app shaped exactly like a generated CRUD router
 * (POST /tasks json body, GET /tasks/:id, GET /tasks query, PUT/DELETE /tasks/:id),
 * backed by an in-memory Map, exposed via createMcpHandler. Asserts the full MCP
 * round trip — initialize, tools/list, tools/call lifecycle — and dispatch unit
 * behavior. No generated code / no example dependency: same shapes, isolated.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { z } from 'zod'
import { createMcpHandler, buildRequest, McpDispatchError, type McpTool } from './index.js'

// --- A tiny CRUD router + store mirroring the generated shape ----------------

const TaskBody = z.object({ title: z.string(), done: z.boolean().optional() }).strict()

function makeApp() {
  const store = new Map<string, { id: string; title: string; done?: boolean }>()
  let seq = 0
  const app = new Hono()
  app.post('/tasks', async (c) => {
    const body = await c.req.json()
    const parsed = TaskBody.safeParse(body)
    if (!parsed.success) return c.json({ code: 'ValidationException' }, 400)
    const item = { id: `t${++seq}`, ...parsed.data }
    store.set(item.id, item)
    return c.json({ item }, 201)
  })
  app.get('/tasks/:id', (c) => {
    const item = store.get(c.req.param('id'))
    if (!item) return c.json({ code: 'TaskNotFound', message: 'not found' }, 404)
    return c.json({ item }, 200)
  })
  app.get('/tasks', (c) => {
    const max = Number(c.req.query('maxResults') ?? '50')
    return c.json({ items: [...store.values()].slice(0, max) }, 200)
  })
  app.put('/tasks/:id', async (c) => {
    const id = c.req.param('id')
    if (!store.has(id)) return c.json({ code: 'TaskNotFound', message: 'not found' }, 404)
    const item = { id, ...(await c.req.json()) }
    store.set(id, item)
    return c.json({ item }, 200)
  })
  app.delete('/tasks/:id', (c) => {
    if (!store.delete(c.req.param('id'))) return c.json({ code: 'TaskNotFound' }, 404)
    return c.body(null, 204)
  })
  return app
}

const tools: McpTool[] = [
  {
    op: { name: 'CreateTask', method: 'POST', path: '/tasks', crudVerb: 'create', resource: 'Task' },
    inputSchema: z.object({ body: TaskBody }).strict(),
    outputSchema: z.object({ item: z.object({ id: z.string() }) }).strict(),
  },
  {
    op: { name: 'GetTask', method: 'GET', path: '/tasks/:id', readonly: true, crudVerb: 'read', resource: 'Task' },
    inputSchema: z.object({ id: z.string() }).strict(),
  },
  {
    op: { name: 'ListTasks', method: 'GET', path: '/tasks', readonly: true, crudVerb: 'list', resource: 'Task' },
    inputSchema: z.object({ maxResults: z.number().int().optional() }).strict(),
  },
  {
    op: { name: 'UpdateTask', method: 'PUT', path: '/tasks/:id', crudVerb: 'update', resource: 'Task' },
    inputSchema: z.object({ id: z.string(), body: TaskBody }).strict(),
  },
  {
    op: { name: 'DeleteTask', method: 'DELETE', path: '/tasks/:id', crudVerb: 'delete', resource: 'Task' },
    inputSchema: z.object({ id: z.string() }).strict(),
  },
]

describe('mcp-core dispatch (buildRequest)', () => {
  const op = tools[2].op // ListTasks
  it('puts non-path/non-body members in the query string', () => {
    const req = buildRequest(op, { maxResults: 5 })
    expect(req.method).toBe('GET')
    expect(new URL(req.url).pathname).toBe('/tasks')
    expect(new URL(req.url).searchParams.get('maxResults')).toBe('5')
  })
  it('substitutes path params and JSON-encodes the body member', async () => {
    const req = buildRequest(tools[3].op, { id: 'abc', body: { title: 'x' } })
    expect(req.method).toBe('PUT')
    expect(new URL(req.url).pathname).toBe('/tasks/abc')
    expect(await req.json()).toEqual({ title: 'x' })
  })
  it('throws McpDispatchError on a missing path param', () => {
    expect(() => buildRequest(tools[1].op, {})).toThrow(McpDispatchError)
  })

  it('appends one query entry per array element instead of comma-joining (MCP-CORE-07)', () => {
    const req = buildRequest(op, { tags: ['a', 'b', 'c'] } as Record<string, unknown>)
    expect(new URL(req.url).searchParams.getAll('tags')).toEqual(['a', 'b', 'c'])
  })

  it('refuses an object/map query member loudly instead of shipping [object Object] (MCP-CORE-07)', () => {
    expect(() => buildRequest(op, { meta: { k: 'v' } } as Record<string, unknown>)).toThrow(
      McpDispatchError,
    )
  })

  it('refuses a non-scalar PATH param loudly instead of lossy String() coercion (MCP-CORE-07)', () => {
    // tools[1] (GetTask) has a `:id` path label — an array or object can't be a scalar id.
    expect(() => buildRequest(tools[1].op, { id: ['a', 'b'] } as Record<string, unknown>)).toThrow(
      McpDispatchError,
    )
    expect(() => buildRequest(tools[1].op, { id: { k: 'v' } } as Record<string, unknown>)).toThrow(
      McpDispatchError,
    )
    // A scalar id is still accepted unchanged.
    expect(new URL(buildRequest(tools[1].op, { id: 'abc' }).url).pathname).toBe('/tasks/abc')
  })
})

describe('mcp-core handler (MCP over JSON-RPC)', () => {
  let handler: (r: Request) => Promise<Response>
  beforeEach(() => {
    handler = createMcpHandler({ tools, app: makeApp(), info: { name: 'test', version: '0.0.0' } })
  })

  const rpc = async (method: string, params?: unknown, id: number | null = 1) => {
    const res = await handler(
      new Request('http://x/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      }),
    )
    return { status: res.status, json: res.status === 202 ? undefined : await res.json() }
  }

  it('initialize echoes the protocol version + advertises tools', async () => {
    const { json } = await rpc('initialize', { protocolVersion: '2025-06-18' })
    expect(json.result.protocolVersion).toBe('2025-06-18')
    expect(json.result.serverInfo).toEqual({ name: 'test', version: '0.0.0' })
    expect(json.result.capabilities.tools).toBeDefined()
  })

  it('initialize negotiates a supported version verbatim (MCP-CORE-06)', async () => {
    const { json } = await rpc('initialize', { protocolVersion: '2024-11-05' })
    expect(json.result.protocolVersion).toBe('2024-11-05')
  })

  it('initialize falls back to the default for an unsupported version (MCP-CORE-06)', async () => {
    const { json } = await rpc('initialize', { protocolVersion: '1999-01-01' })
    expect(json.result.protocolVersion).toBe('2025-06-18')
  })

  it('initialize falls back when the requested version is not a string', async () => {
    const { json } = await rpc('initialize', { protocolVersion: 42 })
    expect(json.result.protocolVersion).toBe('2025-06-18')
  })

  it('tools/list returns every op with schema + annotations + description', async () => {
    const { json } = await rpc('tools/list')
    const list = json.result.tools as Array<Record<string, unknown>>
    expect(list.map((t) => t.name).sort()).toEqual(
      ['CreateTask', 'DeleteTask', 'GetTask', 'ListTasks', 'UpdateTask'],
    )
    const get = list.find((t) => t.name === 'GetTask')!
    expect((get.inputSchema as { type: string }).type).toBe('object')
    expect((get.annotations as { readOnlyHint: boolean }).readOnlyHint).toBe(true)
    expect(get.description).toBe('Get a Task.')
    const del = list.find((t) => t.name === 'DeleteTask')!
    expect((del.annotations as { destructiveHint: boolean }).destructiveHint).toBe(true)
    const create = list.find((t) => t.name === 'CreateTask')!
    expect(create.description).toBe('Create a Task.')
  })

  it('tools/call runs the full CRUD lifecycle in-process', async () => {
    const created = await rpc('tools/call', { name: 'CreateTask', arguments: { body: { title: 'hello' } } })
    expect(created.json.result.isError).toBeFalsy()
    const item = created.json.result.structuredContent.item as { id: string; title: string }
    expect(item.title).toBe('hello')
    const id = item.id

    const got = await rpc('tools/call', { name: 'GetTask', arguments: { id } })
    expect(got.json.result.structuredContent.item.id).toBe(id)

    const listed = await rpc('tools/call', { name: 'ListTasks', arguments: {} })
    expect(listed.json.result.structuredContent.items).toHaveLength(1)

    const del = await rpc('tools/call', { name: 'DeleteTask', arguments: { id } })
    expect(del.json.result.isError).toBeFalsy()

    const gone = await rpc('tools/call', { name: 'GetTask', arguments: { id } })
    expect(gone.json.result.isError).toBe(true)
    expect(gone.json.result.content[0].text).toContain('TaskNotFound')
  })

  it('tools/call on an unknown tool is a JSON-RPC error', async () => {
    const { json } = await rpc('tools/call', { name: 'Nope', arguments: {} })
    expect(json.error.code).toBe(-32602)
  })

  it('a notification (no id) gets 202 and no body', async () => {
    const res = await handler(
      new Request('http://x/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      }),
    )
    expect(res.status).toBe(202)
  })

  it('GET is rejected (no server-initiated SSE in the tool-only server)', async () => {
    const res = await handler(new Request('http://x/mcp', { method: 'GET' }))
    expect(res.status).toBe(405)
  })

  it('an oversized batch is rejected with 413 before any dispatch (MCP-CORE-03)', async () => {
    const capped = createMcpHandler({
      tools,
      app: makeApp(),
      info: { name: 'test', version: '0.0.0' },
      maxBatchSize: 2,
    } as Parameters<typeof createMcpHandler>[0])
    const batch = Array.from({ length: 3 }, (_v, i) => ({
      jsonrpc: '2.0',
      id: i,
      method: 'ping',
    }))
    const res = await capped(
      new Request('http://x/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch),
      }),
    )
    expect(res.status).toBe(413)
    expect((await res.json()).error.code).toBe(-32600)
  })

  it('an oversized body (by Content-Length) is rejected with 413 before parse (MCP-CORE-03)', async () => {
    const capped = createMcpHandler({
      tools,
      app: makeApp(),
      info: { name: 'test', version: '0.0.0' },
      maxBodyBytes: 16,
    } as Parameters<typeof createMcpHandler>[0])
    const res = await capped(
      new Request('http://x/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '9999' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      }),
    )
    expect(res.status).toBe(413)
  })

  it('an oversized body with NO Content-Length is rejected via the streaming backstop (MCP-CORE-03)', async () => {
    const capped = createMcpHandler({
      tools,
      app: makeApp(),
      info: { name: 'test', version: '0.0.0' },
      maxBodyBytes: 64,
    } as Parameters<typeof createMcpHandler>[0])
    // A streaming body carries no Content-Length, so only the streaming byte-counter can
    // stop it — proving the guard no longer trusts the (absent) declared length alone.
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(1000) })
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload))
        controller.close()
      },
    })
    const req = new Request('http://x/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      // Required by the fetch spec when sending a stream body.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })
    expect(req.headers.get('content-length')).toBeNull()
    const res = await capped(req)
    expect(res.status).toBe(413)
    expect((await res.json()).error.code).toBe(-32600)
  })
})
