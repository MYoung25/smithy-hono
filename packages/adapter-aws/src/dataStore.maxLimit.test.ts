/**
 * Focused regression for the optional `maxLimit` clamp (defense-in-depth): a
 * DynamoDB DataStore configured with `maxLimit` silently CLAMPS a `list`'s
 * effective page size to it (BEFORE the `limit + 1` extra-row arithmetic) and
 * still emits a valid resume cursor, while an UNSET `maxLimit` leaves a large
 * `limit` untouched (backwards-compatible default).
 */

import { describe, it, expect } from 'vitest'
import { createDynamoDataStore, createFakeDynamoDataPort } from './dataStore.js'

const SCOPE = { tenantId: 't1' }

interface Row extends Record<string, unknown> {
  id: string
}

async function seed(store: ReturnType<typeof createDynamoDataStore<Row>>, n: number) {
  for (let i = 0; i < n; i++) {
    const id = `k${String(i).padStart(3, '0')}`
    await store.create(id, { id }, SCOPE)
  }
}

describe('DynamoDataStore — maxLimit clamp', () => {
  it('clamps a large limit to maxLimit and returns a valid resume cursor', async () => {
    const store = createDynamoDataStore<Row>(createFakeDynamoDataPort(), { maxLimit: 5 })
    await seed(store, 20)
    const page = await store.list({ limit: 1000 }, SCOPE)
    expect(page.items).toHaveLength(5)
    expect(page.cursor).toBeDefined()
    const page2 = await store.list({ limit: 1000, cursor: page.cursor }, SCOPE)
    expect(page2.items).toHaveLength(5)
    const firstIds = page.items.map((i) => i.id)
    const secondIds = page2.items.map((i) => i.id)
    expect(new Set([...firstIds, ...secondIds]).size).toBe(10)
    expect(secondIds[0] > firstIds[firstIds.length - 1]).toBe(true)
  })

  it('UNSET maxLimit leaves a large limit unchanged (backwards-compatible)', async () => {
    const store = createDynamoDataStore<Row>(createFakeDynamoDataPort())
    await seed(store, 20)
    const page = await store.list({ limit: 1000 }, SCOPE)
    expect(page.items).toHaveLength(20)
    expect(page.cursor).toBeUndefined()
  })
})
