/**
 * Focused regression for the optional `maxLimit` clamp (defense-in-depth): a
 * store configured with `maxLimit` silently CLAMPS a `list`'s effective page size
 * to it and still emits a valid resume cursor, while an UNSET `maxLimit` leaves a
 * large `limit` untouched (backwards-compatible default).
 */

import { describe, it, expect } from 'vitest'
import { createMemoryDataStore } from './memory.js'

const SCOPE = { tenantId: 't1' }

async function seed(store: ReturnType<typeof createMemoryDataStore>, n: number) {
  for (let i = 0; i < n; i++) {
    const id = `k${String(i).padStart(3, '0')}`
    await store.create(id, { id }, SCOPE)
  }
}

describe('MemoryDataStore — maxLimit clamp', () => {
  it('clamps a large limit to maxLimit and returns a valid resume cursor', async () => {
    const store = createMemoryDataStore({ maxLimit: 5 })
    await seed(store, 20)
    const page = await store.list({ limit: 1000 }, SCOPE)
    expect(page.items).toHaveLength(5)
    expect(page.cursor).toBeDefined()
    // The cursor resumes past the clamped page — no rows dropped or duplicated.
    const page2 = await store.list({ limit: 1000, cursor: page.cursor }, SCOPE)
    expect(page2.items).toHaveLength(5)
    const firstIds = page.items.map((i) => (i as { id: string }).id)
    const secondIds = page2.items.map((i) => (i as { id: string }).id)
    expect(new Set([...firstIds, ...secondIds]).size).toBe(10)
    expect(secondIds[0] > firstIds[firstIds.length - 1]).toBe(true)
  })

  it('does NOT clamp a limit already <= maxLimit', async () => {
    const store = createMemoryDataStore({ maxLimit: 50 })
    await seed(store, 20)
    const page = await store.list({ limit: 3 }, SCOPE)
    expect(page.items).toHaveLength(3)
  })

  it('UNSET maxLimit leaves a large limit unchanged (backwards-compatible)', async () => {
    const store = createMemoryDataStore()
    await seed(store, 20)
    const page = await store.list({ limit: 1000 }, SCOPE)
    expect(page.items).toHaveLength(20)
    expect(page.cursor).toBeUndefined()
  })
})
