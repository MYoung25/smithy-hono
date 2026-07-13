/**
 * stdio MCP entry for the crud-api example.
 *
 * A local agent (e.g. Claude Desktop) launches this file as a subprocess and
 * speaks MCP over its stdin/stdout — no HTTP server, no port. We build the same
 * zero-handler CRUD app as `src/index.ts` but with `mcp: false` (the in-process
 * `serveStdio` IS the transport, so we don't also want the HTTP `/mcp` route),
 * then hand `serveStdio` the GENERATED tool manifest (`MCP_TOOLS`) + the app.
 * `tools/call` dispatches into the generated router in-process via `app.fetch`,
 * re-running the generated Zod validation and the default CRUD impl unchanged.
 */

import { serveStdio } from '@smithy-hono/mcp-core/stdio'
import { MCP_TOOLS } from '../generated/mcp.gen'
import { createCrudApp } from './createApp'

const { app } = createCrudApp({ mcp: false })

await serveStdio({ tools: MCP_TOOLS, app, info: { name: 'crud-api', version: '0.1.0' } })
