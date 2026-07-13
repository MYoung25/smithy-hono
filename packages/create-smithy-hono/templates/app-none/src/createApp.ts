/**
 * The app factory — the whole "zero-handler CRUD" service.
 *
 * The `Task` resource is `@persisted`, so the codegen emits a default DB-backed
 * implementation in `generated/task.crud.gen.ts`: `createDefaultTaskOperations(store)`
 * returns an object satisfying the generated `TaskOperations` interface, backed by a
 * pluggable `DataStore<TaskData>`. We hand it a store and mount the generated router
 * — that's the service.
 *
 * `store` is dependency-injected so tests build the SAME app with a fresh in-memory
 * store, and each deploy entry (dev / worker / server / lambda) injects its own
 * durable store. `basePath` prefixes every route (e.g. `/api` in production) so the
 * API sits same-origin under `/api/*` behind the static SPA.
 */
import { Hono } from 'hono'
import type { DataStore } from '@smithy-hono/data-core'
import { createMemoryDataStore } from '@smithy-hono/data-core/memory'
import { createTaskRouter, type TaskData } from './generated/task.gen'
import { createDefaultTaskOperations } from './generated/task.crud.gen'

export interface CreateAppDeps {
  /** The persistence port. Defaults to an in-memory store (dev/test). */
  store?: DataStore<TaskData>
  /** Route prefix, e.g. `/api` in production. Default `''` (root). */
  basePath?: string
}

export function createApp(deps: CreateAppDeps = {}) {
  const store = deps.store ?? createMemoryDataStore<TaskData>()
  const base = deps.basePath ?? ''

  // Zero handler code: the generated default factory IS the implementation.
  const ops = createDefaultTaskOperations(store)

  const app = new Hono()
  app.get(`${base}/healthz`, (c) => c.json({ status: 'ok' }))
  app.route(base || '/', createTaskRouter(ops))

  return { app, store }
}
