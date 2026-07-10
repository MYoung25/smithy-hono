/**
 * Targeted regression for TYPED equality filters (Plan 13 D7) — the case the
 * shared conformance suite MISSES because it only ever filters by string fields.
 *
 * A `@persisted` index/filter on a NUMBER or BOOLEAN field must find the row.
 * The original real port compared `value->>'field'` (Postgres canonical JSONB→
 * text) against `String(filterValue)`, which silently diverges for exotic numbers
 * (`1e21` → PG `'1000000000000000000000'` vs JS `'1e+21'`; `0.0000001` → PG
 * `'0.0000001'` vs JS `'1e-7'`; `1.10` → PG `'1.10'` vs JS `'1.1'`) and returned
 * NO rows. The fake masked it by `String()`-comparing too. This pins both ports
 * to a TYPED comparison. The live counterpart (number/boolean assertions in
 * `live.postgres.dataStore.test.ts`) is the real proof against Postgres.
 */

import { describe, it, expect } from 'vitest'
import { createPostgresDataStore, createFakePgDataPort } from './dataStore.js'

interface Row extends Record<string, unknown> {
  id: string
  qty: number
  active: boolean
}

const NO_SCOPE = {}

// Declare the filtered fields so the exact `count` on them is allowed (an
// undeclared-index count is refused — see the count guard in PostgresDataStore).
const makeStore = () =>
  createPostgresDataStore<Row>(createFakePgDataPort(), { indexes: ['qty', 'active'] })

describe('typed equality filters (number / boolean / exotic number)', () => {
  it('filters by a NUMBER field', async () => {
    const store = makeStore()
    await store.create('a', { id: 'a', qty: 7, active: true }, NO_SCOPE)
    await store.create('b', { id: 'b', qty: 9, active: true }, NO_SCOPE)

    const page = await store.list({ limit: 100, filter: { qty: 7 } }, NO_SCOPE)
    expect(page.items.map((i) => i.id)).toEqual(['a'])
    expect(await store.count!({ filter: { qty: 7 } }, NO_SCOPE)).toBe(1)
  })

  it('filters by a BOOLEAN field', async () => {
    const store = makeStore()
    await store.create('a', { id: 'a', qty: 1, active: true }, NO_SCOPE)
    await store.create('b', { id: 'b', qty: 1, active: false }, NO_SCOPE)

    const page = await store.list({ limit: 100, filter: { active: false } }, NO_SCOPE)
    expect(page.items.map((i) => i.id)).toEqual(['b'])
    expect(await store.count!({ filter: { active: true } }, NO_SCOPE)).toBe(1)
  })

  it('filters by an EXOTIC number whose JS String() diverges from PG text', async () => {
    const store = makeStore()
    // 1e21 / 1e-7 / 1.10 are exactly the values where `String(value)` !==
    // Postgres `value->>'field'`; a TYPED compare matches all three.
    for (const n of [1e21, 0.0000001, 1.1]) {
      const id = `n${n}`
      await store.create(id, { id, qty: n, active: true }, NO_SCOPE)
      const page = await store.list({ limit: 100, filter: { qty: n } }, NO_SCOPE)
      expect(page.items.map((i) => i.id)).toContain(id)
    }
  })
})
