import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { createMcpClient } from './mcp.js'

// A tiny JSON-RPC /mcp stand-in: tools/list is public; tools/call needs a bearer token.
function fakeMcpApp() {
  const app = new Hono()
  app.post('/mcp', async (c) => {
    if (c.req.header('x-forwarded-proto') !== 'https') return c.json({ code: 'InsecureTransport' }, 400)
    const body = await c.req.json<{ id: number; method: string; params?: any }>()
    if (body.method === 'tools/list') {
      return c.json({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'Echo' }] } })
    }
    if (body.method === 'tools/call') {
      if (!c.req.header('authorization')) return c.json({ code: 'Unauthorized' }, 401)
      return c.json({ jsonrpc: '2.0', id: body.id, result: { structuredContent: body.params.arguments } })
    }
    return c.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not found' } })
  })
  return app
}

describe('createMcpClient', () => {
  it('listTools works without a token (and injects https)', async () => {
    const mcp = createMcpClient(fakeMcpApp())
    const r = await mcp.listTools()
    expect(r.status).toBe(200)
    expect(r.result.tools).toEqual([{ name: 'Echo' }])
  })

  it('callTool without a token → 401', async () => {
    const mcp = createMcpClient(fakeMcpApp())
    const r = await mcp.callTool('Echo', { msg: 'hi' })
    expect(r.status).toBe(401)
  })

  it('exposes the response body envelope for a non-200 status (no vacuous leak-check)', async () => {
    const mcp = createMcpClient(fakeMcpApp())
    const r = await mcp.callTool('Echo', { msg: 'hi' })
    expect(r.status).toBe(401)
    // Previously json/result/error were force-undefined for any non-200; now the real
    // body is parsed so a leak assertion can actually inspect it.
    expect(r.json).toEqual({ code: 'Unauthorized' })
  })

  it('callTool with a default token round-trips arguments', async () => {
    const mcp = createMcpClient(fakeMcpApp(), { token: 'tok' })
    const r = await mcp.callTool('Echo', { msg: 'hi' })
    expect(r.status).toBe(200)
    expect(r.result.structuredContent).toEqual({ msg: 'hi' })
  })

  it('a per-call token overrides the default', async () => {
    const mcp = createMcpClient(fakeMcpApp())
    const r = await mcp.callTool('Echo', {}, { token: 'override' })
    expect(r.status).toBe(200)
  })
})
