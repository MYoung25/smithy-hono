/**
 * LIVE conformance — runs the `@smithy-hono/data-core` DataStore conformance
 * suite against the Cloudflare adapter's D1 (and KV) stores wired to a REAL
 * Workers runtime via in-process miniflare: a real D1 database (the SQL CAS,
 * `WHERE`-clause filter/count, opaque-cursor pagination) and a real Workers KV
 * namespace (the key-access subset). This validates the actual SQL / KV
 * semantics that `dataStore.conformance.test.ts` exercises only through the
 * in-process fake ports.
 *
 * Gated on `CF_LIVE=1` so the normal suite skips it (no miniflare needed). To run:
 *
 *   npm i -D miniflare        # (or via scripts/verify-live.sh)
 *   CF_LIVE=1 npx vitest run src/live.miniflare.dataStore.test.ts
 *
 * miniflare/node builtins are imported via non-literal specifiers so this file
 * typechecks WITHOUT those optional deps installed. Each factory call gets a
 * unique D1 table / KV key prefix for isolation within the shared backend; the
 * D1 schema is created in `beforeAll`.
 */

import { beforeAll, afterAll, describe, it } from 'vitest'
import { describeDataStore, type Item } from '@smithy-hono/data-core/conformance'
import type { DataStore } from '@smithy-hono/data-core'
import {
  createD1DataStore,
  createD1DataPort,
  createKvDataStore,
  d1CreateTableSql,
  d1CreateIndexSql,
  type D1DatabaseLike,
} from './dataStore.js'
import type { KvListNamespaceLike } from './dataStore.js'

/** Avoid TS resolving these optional/builtin modules at typecheck time. */
const opt = async (spec: string): Promise<Record<string, unknown>> =>
  import(/* @vite-ignore */ spec) as Promise<Record<string, unknown>>

const RUN = process.env.CF_LIVE === '1'

if (!RUN) {
  describe.skip('adapter-cf — live miniflare D1/KV DataStore (set CF_LIVE=1 to run)', () => {
    it('skipped — CF_LIVE not set', () => {})
  })
} else {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mf: any
  let db: D1DatabaseLike
  let kv: KvListNamespaceLike
  let n = 0

  /** A fresh, isolated D1-backed store per factory call (unique table). */
  const d1Store = async (softDelete: boolean): Promise<DataStore<Item>> => {
    const table = `ds_${softDelete ? 'soft' : 'hard'}_${++n}`
    await db.prepare(d1CreateTableSql(table)).run()
    await db.prepare(d1CreateIndexSql(table, 'kind')).run()
    return createD1DataStore<Item>(createD1DataPort(db, table), { table, indexes: ['kind'], softDelete })
  }

  /** Namespace a KV so each factory call is isolated within the shared KV. */
  const kvStore = (softDelete: boolean): DataStore<Item> =>
    createKvDataStore<Item>(kv, { prefix: `ds:${++n}:`, softDelete })

  beforeAll(async () => {
    const { Miniflare } = (await opt('miniflare')) as unknown as {
      Miniflare: new (o: unknown) => {
        getD1Database(n: string): Promise<unknown>
        getKVNamespace(n: string): Promise<unknown>
        dispose(): Promise<void>
      }
    }
    mf = new Miniflare({
      modules: true,
      script: 'export default { async fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
      kvNamespaces: ['DATA'],
    })
    db = (await mf.getD1Database('DB')) as D1DatabaseLike
    kv = (await mf.getKVNamespace('DATA')) as KvListNamespaceLike
  })

  afterAll(async () => {
    if (mf) await mf.dispose()
  })

  // D1 — primary, full-featured (a fresh table per factory call).
  describeDataStore(
    () => d1Store(false),
    { optimisticConcurrency: true, pagination: true, filter: true, softDelete: false },
  )
  describeDataStore(
    () => d1Store(true),
    { optimisticConcurrency: true, pagination: true, filter: true, softDelete: true },
  )

  // KV — key-access subset (no CAS, no filter).
  describeDataStore(
    () => kvStore(false),
    { optimisticConcurrency: false, pagination: true, filter: false, softDelete: false },
  )
  describeDataStore(
    () => kvStore(true),
    { optimisticConcurrency: false, pagination: true, filter: false, softDelete: true },
  )
}
