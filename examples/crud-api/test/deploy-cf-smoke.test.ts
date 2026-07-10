/**
 * DEPLOY SMOKE — the `deploy/cf-crud` full-stack Worker, end-to-end against a REAL
 * Workers runtime via in-process miniflare.
 *
 * This is the integration the other suites DON'T cover on their own:
 *   - crud-api's `crud-e2e.test.ts` proves the generated router + factory over a
 *     *memory* store;
 *   - adapter-cf's `live.miniflare.dataStore.test.ts` proves the D1 `DataStore`
 *     against real miniflare D1;
 *   - this proves the COMBINATION — the actual `deploy/cf-crud/src/worker.ts`
 *     (generated `Task` router + `createDefaultTaskOperations` wired to a D1-backed
 *     store) bundled and executed as a Worker, serving the full CRUD lifecycle
 *     over a real D1 database in the Workers runtime. It is the deployable artifact
 *     under test, not a re-creation of it.
 *
 * Account-free: miniflare is an in-process Workers runtime — no `wrangler deploy`,
 * no Cloudflare account. Static-asset (UI) serving is platform-declarative
 * (`wrangler.toml [assets]`), not worker logic, so it is out of scope here (it is
 * covered by the manual `wrangler dev` check documented in deploy/cf-crud/README).
 *
 * Gated on `CF_LIVE=1` so the normal suite (and the Gradle crudExampleIntegTest)
 * skips it — no miniflare/esbuild needed there. To run:
 *
 *   npm install miniflare@^3 esbuild@^0.24 --no-save --no-package-lock
 *   CF_LIVE=1 npx vitest run test/deploy-cf-smoke.test.ts
 *
 * miniflare/esbuild/node builtins and `@smithy-hono/adapter-cf` (not a crud-api
 * dependency) are imported via non-literal specifiers so this file resolves and
 * typechecks under the normal suite WITHOUT those present.
 */

import { beforeAll, afterAll, describe, it, expect } from 'vitest'

/** Avoid static resolution of optional/builtin/non-dependency modules. */
const opt = async (spec: string): Promise<Record<string, unknown>> =>
  import(/* @vite-ignore */ spec) as Promise<Record<string, unknown>>

const RUN = process.env.CF_LIVE === '1'

if (!RUN) {
  describe.skip('deploy/cf-crud — live miniflare Worker smoke (set CF_LIVE=1 to run)', () => {
    it('skipped — CF_LIVE not set', () => {})
  })
} else {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mf: any

  const json = async (r: Response) => ({ status: r.status, body: await r.json() })

  beforeAll(async () => {
    const path = await opt('node:path')
    const esbuild = await opt('esbuild')
    const adapterCf = await opt('@smithy-hono/adapter-cf')
    const { Miniflare } = (await opt('miniflare')) as unknown as {
      Miniflare: new (o: unknown) => {
        getD1Database(n: string): Promise<{ prepare(sql: string): { run(): Promise<unknown> } }>
        dispatchFetch(url: string, init?: RequestInit): Promise<Response>
        dispose(): Promise<void>
      }
    }

    // Bundle the REAL deploy worker (resolves @smithy-hono/adapter-cf + data-core
    // from the built workspace packages and the generated router from
    // examples/crud-api). Worker-runtime export conditions mirror wrangler.
    const here = (path.dirname as (p: string) => string)(new URL(import.meta.url).pathname)
    const workerPath = (path.resolve as (...p: string[]) => string)(
      here,
      '../../../deploy/cf-crud/src/worker.ts',
    )
    const result = (await (
      esbuild.build as (o: unknown) => Promise<{ outputFiles: { text: string }[] }>
    )({
      entryPoints: [workerPath],
      bundle: true,
      format: 'esm',
      write: false,
      platform: 'neutral',
      conditions: ['workerd', 'worker', 'browser', 'module', 'import', 'default'],
      mainFields: ['module', 'main'],
    }))

    mf = new Miniflare({
      modules: true,
      script: result.outputFiles[0].text,
      d1Databases: ['DB'],
    })

    // Seed the same D1 the worker reads (binding `DB`) with the adapter's schema.
    const { d1CreateTableSql } = adapterCf as unknown as {
      d1CreateTableSql: (table: string) => string
    }
    const db = await mf.getD1Database('DB')
    await db.prepare(d1CreateTableSql('tasks')).run()
  })

  afterAll(async () => {
    if (mf) await mf.dispose()
  })

  describe('deploy/cf-crud migration — no schema drift', () => {
    it('migrations/0001_init.sql matches the adapter d1CreateTableSql', async () => {
      // The migration is a hand-copy of the adapter's canonical schema, and a real
      // `wrangler deploy` applies the .sql FILE (not the function the smoke seeds
      // from) — so without this the smoke could stay green while a deploy provisions
      // a stale schema. Compare them, comment/whitespace-insensitive.
      const fs = await opt('node:fs')
      const path = await opt('node:path')
      const { d1CreateTableSql } = (await opt('@smithy-hono/adapter-cf')) as unknown as {
        d1CreateTableSql: (table: string) => string
      }
      const here = (path.dirname as (p: string) => string)(new URL(import.meta.url).pathname)
      const sqlPath = (path.resolve as (...p: string[]) => string)(
        here,
        '../../../deploy/cf-crud/migrations/0001_init.sql',
      )
      const fileSql = (fs.readFileSync as (p: string, enc: string) => string)(sqlPath, 'utf8')
      const norm = (s: string) =>
        s
          .replace(/--.*$/gm, '') // strip SQL line comments
          .replace(/\s+/g, ' ')
          .trim()
      expect(norm(fileSql)).toBe(norm(d1CreateTableSql('tasks')))
    })
  })

  describe('deploy/cf-crud Worker — CRUD lifecycle over real D1', () => {
    it('serves the full create/read/update/delete lifecycle', async () => {
      const base = 'http://localhost'

      // CREATE → 201 { item } with server-assigned id + version 1.
      const created = await json(
        await mf.dispatchFetch(`${base}/tasks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'smoke task', done: false }),
        }),
      )
      expect(created.status).toBe(201)
      const item = (created.body as { item: { id: string; version: number; title: string } }).item
      expect(item.id).toBeTruthy()
      expect(item.title).toBe('smoke task')
      expect(item.version).toBe(1)
      const id = item.id

      // LIST → 200 { items } containing the new task (proves cross-request D1
      // persistence — the worker builds a fresh store per request).
      const listed = await json(await mf.dispatchFetch(`${base}/tasks`))
      expect(listed.status).toBe(200)
      const items = (listed.body as { items: { id: string }[] }).items
      expect(items.some((t) => t.id === id)).toBe(true)

      // READ → 200 { item }.
      const read = await json(await mf.dispatchFetch(`${base}/tasks/${id}`))
      expect(read.status).toBe(200)
      expect((read.body as { item: { id: string } }).item.id).toBe(id)

      // UPDATE → 200, version bumped.
      const updated = await json(
        await mf.dispatchFetch(`${base}/tasks/${id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'smoke task', done: true }),
        }),
      )
      expect(updated.status).toBe(200)
      const after = (updated.body as { item: { version: number; done: boolean } }).item
      expect(after.done).toBe(true)
      expect(after.version).toBe(2)

      // DELETE → 204 (bare @persisted = hard delete).
      const del = await mf.dispatchFetch(`${base}/tasks/${id}`, { method: 'DELETE' })
      expect(del.status).toBe(204)

      // READ after delete → 404 TaskNotFound.
      const gone = await json(await mf.dispatchFetch(`${base}/tasks/${id}`))
      expect(gone.status).toBe(404)
      expect((gone.body as { code: string }).code).toBe('TaskNotFound')
    })
  })
}
