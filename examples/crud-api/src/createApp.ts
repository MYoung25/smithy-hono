/**
 * The crud-api example's app factory — the entire "zero-handler CRUD" demonstration
 * (Plan 13, P4).
 *
 * There is NO `implementation.ts`. The Task resource is `@persisted`, so the codegen
 * emits a default DB-backed implementation in `generated/task.crud.gen.ts`:
 * `createDefaultTaskOperations(store)` returns an object satisfying the generated
 * `TaskOperations` interface (create/read/update/delete/list), backed entirely by a
 * pluggable `DataStore<TaskData>`. We hand it an in-memory store and mount the
 * generated router — that's the whole service.
 *
 * The store is dependency-injected so the e2e test can build the SAME app with its
 * own fresh memory store per test, exactly as todo-api/secure-api do.
 *
 * The same app also serves itself as an MCP server at `/mcp` (Plan 14): every
 * generated operation is exposed as an MCP tool over a stateless Streamable-HTTP
 * endpoint, so LLM agents can discover and call them. Because both the Node entry
 * (`src/index.ts`) and the Cloudflare Worker (`deploy/cf-crud`) build on this one
 * factory, the live `/mcp` mount ships on every runtime with no extra wiring.
 */

import { Hono } from 'hono'
import type { DataStore } from '@smithy-hono/data-core'
import { createMemoryDataStore } from '@smithy-hono/data-core/memory'
import { createMcpHandler } from '@smithy-hono/mcp-core'
import { createTaskRouter, type TaskData } from '../generated/task.gen'
import { createDefaultTaskOperations } from '../generated/task.crud.gen'
import { MCP_TOOLS, MCP_PROMPTS } from '../generated/mcp.gen'

export interface CreateCrudAppDeps {
  /** The persistence port. Defaults to an in-memory store (dev/test). */
  store?: DataStore<TaskData>
  /**
   * Mount the MCP server at `/mcp`. Defaults to `true` — the live mount is the
   * whole point of the demo; pass `false` for a router-only app.
   */
  mcp?: boolean
}

export function createCrudApp(deps: CreateCrudAppDeps = {}) {
  const store = deps.store ?? createMemoryDataStore<TaskData>()

  // Zero handler code: the generated default factory IS the implementation.
  const ops = createDefaultTaskOperations(store)

  const app = new Hono()
  app.route('/', createTaskRouter(ops))

  // Live MCP mount: the GENERATED tool manifest (mcp.gen.ts) + the same `app`.
  // `tools/call` dispatches in-process via `app.fetch`, so it re-runs the generated
  // Zod validation and the default CRUD impl unchanged — no logic duplicated, no
  // network hop. Web-standard-only, so this is identical on Node and CF Workers.
  if (deps.mcp !== false) {
    const mcp = createMcpHandler({
      tools: MCP_TOOLS,
      prompts: MCP_PROMPTS,
      app,
      info: { name: 'crud-api', version: '0.1.0' },
    })
    app.all('/mcp', (c) => mcp(c.req.raw))
  }

  return { app, store }
}
