/**
 * MCP e2e — drives the LIVE `/mcp` mount that `createCrudApp` wires in (Plan 14):
 * the @smithy-hono/mcp-core bridge over the REAL generated crud-api router + memory
 * store. This is the SAME app the Node entry (src/index.ts) and the Cloudflare
 * Worker (deploy/cf-crud) boot, so it proves the shipped MCP surface — not a
 * test-only assembly. Asserts the full lifecycle: initialize / tools/list /
 * tools/call (CRUD round-trip) plus modeled-error + validation-error mapping.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createMemoryDataStore } from '@smithy-hono/data-core/memory'
import { createCrudApp } from '../src/createApp'
import type { TaskData } from '../generated/task.gen'

describe('crud-api MCP bridge (live /mcp mount)', () => {
  let app: ReturnType<typeof createCrudApp>['app']

  const rpc = async (method: string, params?: unknown, id: number | null = 1) => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, json: (res.status === 202 ? undefined : await res.json()) as any }
  }

  beforeEach(() => {
    app = createCrudApp({ store: createMemoryDataStore<TaskData>() }).app
  })

  it('initialize negotiates the protocol and advertises the server', async () => {
    const { json } = await rpc('initialize')
    expect(json.result.serverInfo.name).toBe('crud-api')
    expect(json.result.capabilities.tools).toBeDefined()
  })

  it('tools/list advertises the generated CRUD operations', async () => {
    const { json } = await rpc('tools/list')
    const names = (json.result.tools as Array<{ name: string }>).map((t) => t.name).sort()
    expect(names).toEqual(['CreateTask', 'DeleteTask', 'GetTask', 'ListTasks', 'UpdateTask'])
    const get = (json.result.tools as Array<Record<string, unknown>>).find((t) => t.name === 'GetTask')!
    expect((get.annotations as { readOnlyHint: boolean }).readOnlyHint).toBe(true)
    // inputSchema is the generated Zod schema rendered to JSON Schema.
    expect((get.inputSchema as { properties: Record<string, unknown> }).properties.id).toBeDefined()
    // description flows from the model's @documentation through the registry.
    expect(get.description).toContain('Fetch a single Task by its id')
  })

  it('tools/call runs the real CRUD lifecycle through the generated router', async () => {
    const created = await rpc('tools/call', {
      name: 'CreateTask',
      arguments: { body: { title: 'via mcp', done: false } },
    })
    const item = created.json.result.structuredContent.item as { id: string; title: string }
    expect(item.title).toBe('via mcp')
    const id = item.id

    const got = await rpc('tools/call', { name: 'GetTask', arguments: { id } })
    expect(got.json.result.structuredContent.item.id).toBe(id)

    const updated = await rpc('tools/call', {
      name: 'UpdateTask',
      arguments: { id, body: { title: 'via mcp', done: true } },
    })
    expect(updated.json.result.structuredContent.item.done).toBe(true)

    const del = await rpc('tools/call', { name: 'DeleteTask', arguments: { id } })
    expect(del.json.result.isError).toBeFalsy()

    const gone = await rpc('tools/call', { name: 'GetTask', arguments: { id } })
    expect(gone.json.result.isError).toBe(true)
    expect(gone.json.result.content[0].text).toContain('TaskNotFound')
  })

  it('a validation failure surfaces as an MCP tool error', async () => {
    // missing required `title` → generated zValidator rejects → 400 → isError.
    const bad = await rpc('tools/call', { name: 'CreateTask', arguments: { body: { done: true } } })
    expect(bad.json.result.isError).toBe(true)
  })

  it('initialize advertises the resources capability (derived from the read op)', async () => {
    const { json } = await rpc('initialize')
    expect(json.result.capabilities.resources).toEqual({ listChanged: false })
  })

  it('resources/templates/list includes the task://{id} template', async () => {
    const { json } = await rpc('resources/templates/list')
    const tpl = (json.result.resourceTemplates as Array<Record<string, unknown>>).find(
      (t) => t.uriTemplate === 'task://{id}',
    )
    expect(tpl).toBeDefined()
    expect(tpl!.name).toBe('Task')
    expect(tpl!.mimeType).toBe('application/json')
  })

  it('resources/read of a created task returns its JSON in contents', async () => {
    const created = await rpc('tools/call', {
      name: 'CreateTask',
      arguments: { body: { title: 'resource me', done: false } },
    })
    const id = (created.json.result.structuredContent.item as { id: string }).id

    const read = await rpc('resources/read', { uri: `task://${id}` })
    const contents = read.json.result.contents as Array<{ uri: string; text: string }>
    expect(contents).toHaveLength(1)
    expect(contents[0].uri).toBe(`task://${id}`)
    expect(JSON.parse(contents[0].text).item.id).toBe(id)
  })

  it('resources/list includes the created task', async () => {
    const created = await rpc('tools/call', {
      name: 'CreateTask',
      arguments: { body: { title: 'listed', done: false } },
    })
    const id = (created.json.result.structuredContent.item as { id: string }).id

    const { json } = await rpc('resources/list')
    const uris = (json.result.resources as Array<{ uri: string }>).map((r) => r.uri)
    expect(uris).toContain(`task://${id}`)
  })

  it('resources/read of an unknown uri is a JSON-RPC error', async () => {
    const { json } = await rpc('resources/read', { uri: 'widget://nope' })
    expect(json.error.code).toBe(-32602)
  })

  it('initialize advertises the prompts capability (from the authored @mcpPrompts)', async () => {
    const { json } = await rpc('initialize')
    expect(json.result.capabilities.prompts).toEqual({ listChanged: false })
  })

  it('prompts/list advertises the authored triage-tasks + create-task prompts', async () => {
    const { json } = await rpc('prompts/list')
    const names = (json.result.prompts as Array<{ name: string }>).map((p) => p.name).sort()
    expect(names).toEqual(['create-task', 'triage-tasks'])
    // Descriptors are public metadata only — the template never leaks to the client.
    expect(JSON.stringify(json.result.prompts)).not.toContain('Set a sensible title')
  })

  it('prompts/get create-task interpolates the body (public — needs NO token)', async () => {
    const { status, json } = await rpc('prompts/get', {
      name: 'create-task',
      arguments: { body: 'pick up the dry cleaning' },
    })
    expect(status).toBe(200)
    const [msg] = json.result.messages as Array<{ role: string; content: { type: string; text: string } }>
    expect(msg.role).toBe('user')
    expect(msg.content.type).toBe('text')
    expect(msg.content.text).toContain('pick up the dry cleaning')
  })

  it('prompts/get triage-tasks omitting the optional focus → empty substitution, no error', async () => {
    const { json } = await rpc('prompts/get', { name: 'triage-tasks' })
    expect(json.error).toBeUndefined()
    const text = (json.result.messages as Array<{ content: { text: string } }>)[0].content.text
    // The optional {focus} placeholder collapses to '' — and is gone from the text.
    expect(text).toContain('Focus on: .')
    expect(text).not.toContain('{focus}')
  })
})
