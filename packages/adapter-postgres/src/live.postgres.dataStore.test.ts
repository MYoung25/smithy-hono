/**
 * LIVE conformance — runs the `@smithy-hono/data-core` DataStore conformance
 * suite against the Postgres adapter's store wired to a REAL Postgres via the
 * real {@link createPgDataPort} over a `pg` `Pool`. This validates the actual
 * versioned CAS (`UPDATE ... WHERE version = $`), the `INSERT ... ON CONFLICT`
 * create-if-absent / tombstone-resurrect, the server-side `WHERE value->>'field'
 * = $n` filter + `COUNT(*)`, and the opaque-cursor pagination — the semantics
 * `dataStore.conformance.test.ts` exercises only through the in-process fake port.
 *
 * Gated on `DATABASE_URL` (or `POSTGRES_URL`) so the normal suite skips it
 * (mirrors the other `live.*.test.ts`). To run:
 *
 *   docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16-alpine
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
 *     npx vitest run src/live.postgres.dataStore.test.ts
 *
 * The `pg` driver is imported via a non-literal specifier so this file typechecks
 * WITHOUT it installed (it is a live-test-only dep). Each factory call creates its
 * OWN table (a unique name) in `beforeAll`/on demand, so the conformance variants
 * are isolated within the shared database; all created tables are dropped in
 * `afterAll`.
 */

import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { describeDataStore, type Item } from '@smithy-hono/data-core/conformance'
import type { DataStore } from '@smithy-hono/data-core'
import {
  createPostgresDataStore,
  createPgDataPort,
  pgCreateTableSql,
  pgCreateIndexSql,
  type PgClientLike,
} from './dataStore.js'

/** Avoid TS resolving the optional `pg` module at typecheck time. */
const opt = async (spec: string): Promise<Record<string, unknown>> =>
  import(/* @vite-ignore */ spec) as Promise<Record<string, unknown>>

const URL = process.env.DATABASE_URL ?? process.env.POSTGRES_URL

if (!URL) {
  describe.skip('adapter-postgres — live Postgres DataStore (set DATABASE_URL to run)', () => {
    it('skipped — DATABASE_URL / POSTGRES_URL not set', () => {})
  })
} else {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any
  let client: PgClientLike
  let n = 0
  // A per-run id so tables from a previous run against the SAME persistent
  // Postgres never collide with this run's tables.
  const RUN = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  const created: string[] = []

  /** A fresh, isolated Postgres-backed store per factory call (unique table). */
  const store = async (softDelete: boolean): Promise<DataStore<Item>> => {
    const table = `ds_live_${RUN}_${softDelete ? 'soft' : 'hard'}_${++n}`
    await client.query(pgCreateTableSql(table))
    await client.query(pgCreateIndexSql(table, 'kind'))
    created.push(table)
    return createPostgresDataStore<Item>(createPgDataPort(client, table), {
      table,
      indexes: ['kind'],
      softDelete,
    })
  }

  beforeAll(async () => {
    const { Pool } = (await opt('pg')) as unknown as {
      Pool: new (o: unknown) => {
        query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
        end(): Promise<void>
      }
    }
    pool = new Pool({ connectionString: URL })
    client = pool as PgClientLike
  })

  afterAll(async () => {
    if (pool) {
      for (const table of created) {
        await pool.query(`DROP TABLE IF EXISTS "${table.replace(/"/g, '""')}"`)
      }
      await pool.end()
    }
  })

  // Postgres — primary, full-featured (a fresh table per factory call).
  describeDataStore(
    () => store(false),
    { optimisticConcurrency: true, pagination: true, filter: true, softDelete: false },
  )
  describeDataStore(
    () => store(true),
    { optimisticConcurrency: true, pagination: true, filter: true, softDelete: true },
  )

  // --- TYPED filter regression (Plan 13 D7) — the case the shared conformance
  // suite misses: it only filters by STRING fields, so the `value->>'field' =
  // String(value)` vs canonical JSONB→text divergence for NUMBER/BOOLEAN (and
  // exotic numbers like 1e21) never surfaced. This is the REAL proof, since the
  // bug only manifests against real Postgres `->>` text. ----------------------
  describe('adapter-postgres — live typed (number/boolean) equality filters', () => {
    interface Row extends Record<string, unknown> {
      id: string
      qty: number
      active: boolean
    }

    const typedStore = async (): Promise<ReturnType<typeof createPostgresDataStore<Row>>> => {
      const table = `ds_live_${RUN}_typed_${++n}`
      await client.query(pgCreateTableSql(table))
      await client.query(pgCreateIndexSql(table, 'qty'))
      await client.query(pgCreateIndexSql(table, 'active'))
      created.push(table)
      // Declare the indexed fields so the exact `count` on them is allowed (an
      // undeclared-index count is refused — see the count guard in PostgresDataStore).
      return createPostgresDataStore<Row>(createPgDataPort(client, table), {
        table,
        indexes: ['qty', 'active'],
      })
    }

    it('filters by a NUMBER field against real Postgres', async () => {
      const store = await typedStore()
      await store.create('a', { id: 'a', qty: 7, active: true }, {})
      await store.create('b', { id: 'b', qty: 9, active: false }, {})
      const page = await store.list({ limit: 100, filter: { qty: 7 } }, {})
      expect(page.items.map((i) => i.id)).toEqual(['a'])
      expect(await store.count!({ filter: { qty: 7 } }, {})).toBe(1)
    })

    it('filters by a BOOLEAN field against real Postgres', async () => {
      const store = await typedStore()
      await store.create('a', { id: 'a', qty: 1, active: true }, {})
      await store.create('b', { id: 'b', qty: 1, active: false }, {})
      const page = await store.list({ limit: 100, filter: { active: false } }, {})
      expect(page.items.map((i) => i.id)).toEqual(['b'])
      expect(await store.count!({ filter: { active: true } }, {})).toBe(1)
    })

    it('filters by EXOTIC numbers where String(value) diverges from PG ->> text', async () => {
      const store = await typedStore()
      // 1e21 / 1e-7 / 1.10: each is a value where JS `String(value)` !==
      // Postgres `value->>'qty'`. A TYPED `(value->'qty')::numeric = $::numeric`
      // matches; the old text compare returned NOTHING.
      for (const num of [1e21, 0.0000001, 1.1]) {
        const id = `n${num}`
        await store.create(id, { id, qty: num, active: true }, {})
        const page = await store.list({ limit: 100, filter: { qty: num } }, {})
        expect(page.items.map((i) => i.id)).toContain(id)
        expect(await store.count!({ filter: { qty: num } }, {})).toBe(1)
      }
    })

    it('a number filter does NOT raise a cast error on mixed-type rows', async () => {
      const store = await typedStore()
      // A row whose `qty` is a STRING (and one absent field) must not break the
      // numeric cast for the matching row — the jsonb_typeof guard short-circuits.
      await store.create('num', { id: 'num', qty: 5, active: true }, {})
      await store.put('str', { id: 'str', qty: 'oops' as unknown as number, active: true }, {})
      const page = await store.list({ limit: 100, filter: { qty: 5 } }, {})
      expect(page.items.map((i) => i.id)).toEqual(['num'])
    })
  })
}
