/**
 * Prompt handler integration (§12.8) over a fake dispatch `app` (FetchLike): proves the
 * protocol wiring end to end — `initialize` advertises the `prompts` capability iff prompts
 * are present (and NOT when empty), `prompts/list` returns the public descriptors,
 * `prompts/get` of a known prompt interpolates into a single user-text message, a missing
 * REQUIRED arg → -32602, and an unknown prompt name → -32602. Prompts never dispatch, so
 * there is no auth case here (§12.3).
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createMcpHandler, type FetchLike, type McpPrompt, type McpTool } from './index.js'

const schema = z.object({}).strict()

const tools: McpTool[] = [
  {
    op: { name: 'ListTasks', method: 'GET', path: '/tasks', readonly: true, crudVerb: 'list', resource: 'Task' },
    inputSchema: schema,
  },
]

const prompts: McpPrompt[] = [
  {
    name: 'triage-tasks',
    description: 'Review the open tasks.',
    arguments: [{ name: 'focus', description: 'Area to prioritize', required: false }],
    template: 'Propose a priority order. Focus on: {focus}.',
  },
  {
    name: 'create-task',
    description: 'Draft a new task.',
    arguments: [{ name: 'body', required: true }],
    template: 'Create a task from: {body}.',
  },
]

// A stub app — prompts never dispatch, so it is never actually called.
const app: FetchLike = { fetch: () => new Response('not found', { status: 404 }) }

function driver(handler: (r: Request) => Promise<Response>) {
  return (method: string, params?: unknown) =>
    handler(
      new Request('http://x/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
    )
}

describe('mcp-core prompts handler (§12)', () => {
  const handler = createMcpHandler({ tools, prompts, app, info: { name: 'test', version: '0.0.0' } })
  const rpc = driver(handler)

  it('initialize advertises the prompts capability when prompts are present', async () => {
    const json = await (await rpc('initialize')).json()
    expect(json.result.capabilities.prompts).toEqual({ listChanged: false })
  })

  it('initialize does NOT advertise prompts when none are configured', async () => {
    const off = createMcpHandler({ tools, app, info: { name: 'test', version: '0.0.0' } })
    const json = await (await driver(off)('initialize')).json()
    expect(json.result.capabilities.prompts).toBeUndefined()
  })

  it('prompts/list returns the public descriptors (no template, required defaulted)', async () => {
    const json = await (await rpc('prompts/list')).json()
    expect(json.result.prompts).toEqual([
      {
        name: 'triage-tasks',
        description: 'Review the open tasks.',
        arguments: [{ name: 'focus', description: 'Area to prioritize', required: false }],
      },
      {
        name: 'create-task',
        description: 'Draft a new task.',
        arguments: [{ name: 'body', description: undefined, required: true }],
      },
    ])
    expect(JSON.stringify(json.result.prompts)).not.toContain('Create a task from')
  })

  it('prompts/get happy path returns a single user-text message', async () => {
    const json = await (await rpc('prompts/get', { name: 'create-task', arguments: { body: 'buy milk' } })).json()
    expect(json.result.description).toBe('Draft a new task.')
    expect(json.result.messages).toEqual([
      { role: 'user', content: { type: 'text', text: 'Create a task from: buy milk.' } },
    ])
  })

  it('prompts/get with a missing required arg → -32602', async () => {
    const json = await (await rpc('prompts/get', { name: 'create-task' })).json()
    expect(json.error.code).toBe(-32602)
    expect(json.error.message).toContain('body')
  })

  it('prompts/get of an unknown prompt → -32602', async () => {
    const json = await (await rpc('prompts/get', { name: 'nope' })).json()
    expect(json.error.code).toBe(-32602)
    expect(json.error.message).toContain('unknown prompt')
  })
})
