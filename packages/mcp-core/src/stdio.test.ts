/**
 * stdio transport proof: drive `serveStdio` with a mock async-iterable `input`
 * (newline-delimited JSON-RPC split across arbitrary chunk boundaries) and a
 * collector `output`, over a tiny fake `app: FetchLike`. Asserts the framing —
 * one response line per request, NO line for a notification, and a `-32700`
 * parse-error line for a malformed line. Mirrors mcp.test.ts's fake-app idiom
 * but exercises the stdio path instead of the HTTP handler.
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import type { FetchLike, McpTool } from './index.js'
import { serveStdio, createLineBuffer } from './stdio.js'

// A minimal CRUD-shaped app (mirrors the generated router): POST /tasks echoes
// the body back as an item with an id.
const TaskBody = z.object({ title: z.string() }).strict()

const app: FetchLike = {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/tasks') {
      const body = await request.json()
      return Response.json({ item: { id: 't1', ...body } }, { status: 201 })
    }
    return new Response('not found', { status: 404 })
  },
}

const tools: McpTool[] = [
  {
    op: { name: 'CreateTask', method: 'POST', path: '/tasks', crudVerb: 'create', resource: 'Task' },
    inputSchema: z.object({ body: TaskBody }).strict(),
  },
]

/** An async-iterable input that yields the given chunks (arbitrary boundaries). */
function chunks(...parts: string[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const part of parts) yield part
    },
  }
}

describe('createLineBuffer', () => {
  it('reassembles lines across chunk boundaries', () => {
    const buf = createLineBuffer()
    expect(buf.push('hel')).toEqual([])
    expect(buf.push('lo\nwor')).toEqual(['hello'])
    expect(buf.push('ld\n')).toEqual(['world'])
    expect(buf.flush()).toEqual([])
  })

  it('flush returns an unterminated final line', () => {
    const buf = createLineBuffer()
    expect(buf.push('a\nbc')).toEqual(['a'])
    expect(buf.flush()).toEqual(['bc'])
  })

  it('discards an over-long line and signals overflow instead of growing unbounded', () => {
    const overflows: number[] = []
    const buf = createLineBuffer({ maxLineBytes: 8, onOverflow: () => overflows.push(1) })
    // A long partial line with no newline exceeds the cap → dropped, overflow signaled once.
    expect(buf.push('x'.repeat(20))).toEqual([])
    expect(buf.push('y'.repeat(20))).toEqual([]) // still discarding, no second signal
    expect(overflows).toHaveLength(1)
    // The newline ends the discarded line; the buffer resumes normal framing after it.
    expect(buf.push('junk\nok\n')).toEqual(['ok'])
    expect(buf.flush()).toEqual([])
  })
})

describe('serveStdio (MCP over newline-delimited JSON-RPC)', () => {
  it('frames responses: result lines, no notification line, parse error line', async () => {
    const lines = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'CreateTask', arguments: { body: { title: 'hi' } } } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      'this is not json',
    ]
    // Reassemble the whole conversation, then re-split it into ragged chunks that
    // straddle the line boundaries to prove the buffering handles them.
    const wire = lines.join('\n') + '\n'
    const input = chunks(wire.slice(0, 10), wire.slice(10, 73), wire.slice(73))

    const out: string[] = []
    await serveStdio({ tools, app, info: { name: 'crud-api', version: '0.1.0' } }, {
      input,
      output: (line) => out.push(line),
    })

    // Every emitted line is `\n`-terminated and parses as one JSON-RPC response.
    for (const line of out) expect(line.endsWith('\n')).toBe(true)
    const responses = out.map((line) => JSON.parse(line))

    // 3 requests + 1 parse error; the notification produced nothing.
    expect(responses).toHaveLength(4)

    const init = responses[0]
    expect(init.id).toBe(1)
    expect(init.result.protocolVersion).toBe('2025-06-18')
    expect(init.result.serverInfo).toEqual({ name: 'crud-api', version: '0.1.0' })

    const list = responses[1]
    expect(list.id).toBe(2)
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(['CreateTask'])

    const call = responses[2]
    expect(call.id).toBe(3)
    expect(call.result.isError).toBeFalsy()
    expect(call.result.structuredContent.item).toEqual({ id: 't1', title: 'hi' })

    // The malformed line → JSON-RPC parse error (-32700, null id), no others.
    const parseError = responses[3]
    expect(parseError).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
  })

  it('emits a parse error for an over-long line (maxLineBytes OOM guard) then keeps serving', async () => {
    const valid = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' })
    const out: string[] = []
    await serveStdio({ tools, app, info: { name: 'crud-api', version: '0.1.0' } }, {
      // A huge unterminated blob (no newline) followed by a valid request line.
      input: chunks('z'.repeat(200), 'z'.repeat(200), '\n' + valid + '\n'),
      maxLineBytes: 64,
      output: (line) => out.push(line),
    })
    const responses = out.map((line) => JSON.parse(line))
    // The over-long line produced exactly one parse error; the valid line still served.
    expect(responses[0]).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    expect(responses[responses.length - 1].id).toBe(7)
    expect(responses[responses.length - 1].result.tools.map((t: { name: string }) => t.name)).toEqual(['CreateTask'])
  })

  it('skips blank lines and defaults to no output for an empty stream', async () => {
    const out: string[] = []
    await serveStdio({ tools, app, info: { name: 'crud-api', version: '0.1.0' } }, {
      input: chunks('\n', '   \n', ''),
      output: (line) => out.push(line),
    })
    expect(out).toEqual([])
  })
})
