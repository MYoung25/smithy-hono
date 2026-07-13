/**
 * Cloudflare Worker entry. Serves the generated router (backed by a D1 DataStore)
 * under `/api/*`; the built SPA (if any) is served by the platform from `[assets]`
 * (see the rendered wrangler.toml), so the browser talks same-origin.
 *
 * ARCH-01: web-standard APIs only — no `node:*` import. The real `D1Database`
 * binding structurally satisfies the adapter's narrow `D1DatabaseLike` port, so this
 * typechecks without `@cloudflare/workers-types`. Construct the store per request —
 * Workers isolates are stateless.
 */
import {
  createD1DataStore,
  createD1DataPort,
  type D1DatabaseLike,
} from '@smithy-hono/adapter-cf'
import { createApp } from './createApp'
import type { TaskData } from './generated/task.gen'

export interface Env {
  /** D1 database backing the Task store. Binding name MUST be `DB` (wrangler.toml). */
  DB: D1DatabaseLike
}

const TABLE = 'tasks'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const store = createD1DataStore<TaskData>(createD1DataPort(env.DB, TABLE), { table: TABLE })
    const { app } = createApp({ store, basePath: '/api' })
    return app.fetch(request)
  },
}
