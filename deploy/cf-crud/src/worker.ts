/**
 * Cloudflare Worker entry for the zero-handler CRUD demo (examples/crud-api),
 * served full-stack on Workers:
 *
 *   - the generated `Task` router (examples/crud-api/generated/task.gen) backed by
 *     a D1 DataStore (`@smithy-hono/adapter-cf`) — the SAME generated factory the
 *     Node entry (examples/crud-api/src/index.ts) uses, just with a D1-backed
 *     store instead of the in-memory one, proving the codegen + DataStore port is
 *     runtime-agnostic;
 *   - the React UI (examples/crud-ui) served as static assets by the platform
 *     (see wrangler.toml `[assets]`), so the browser hits `/tasks` same-origin —
 *     exactly the model the Vite dev proxy reproduces locally.
 *
 * ARCH-01: web-standard APIs only — no `node:*` import. The real `D1Database`
 * binding structurally satisfies the adapter's narrow `D1DatabaseLike` port, so
 * this typechecks WITHOUT `@cloudflare/workers-types`.
 *
 * Contrast with the Node entry, which uses `@hono/node-server`'s `serve()` and an
 * ephemeral in-memory store — neither of which works on Workers (no `serve()`;
 * memory is per-isolate and would lose data between requests). D1 is the durable,
 * strongly-consistent backing store here.
 */

import {
  createD1DataStore,
  createD1DataPort,
  type D1DatabaseLike,
} from '@smithy-hono/adapter-cf'
import { createCrudApp } from '../../../examples/crud-api/src/createApp'
import type { TaskData } from '../../../examples/crud-api/generated/task.gen'

/**
 * The bindings this Worker reads. `DB` is the D1 database backing the Task store;
 * a real `D1Database` is a structural superset of `D1DatabaseLike`. Static assets
 * (the UI) are handled by the platform, not via a binding here.
 */
export interface Env {
  DB: D1DatabaseLike
}

const TABLE = 'tasks'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Sessions/rate-limit/nonce aren't involved — the CRUD demo's ops are all
    // @optionalAuth, so there's no security pipeline (and thus no Durable Object
    // / KV dependency). Reuse the example's DI-designed app factory so the Worker
    // shares ONE Hono with the generated router it mounts (no version skew) and
    // stays free of any direct `hono` import — only the backing store changes from
    // the Node entry's in-memory store to this D1-backed one.
    const store = createD1DataStore<TaskData>(createD1DataPort(env.DB, TABLE), { table: TABLE })
    const { app } = createCrudApp({ store })
    return app.fetch(request)
  },
}
