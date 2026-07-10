import { describe, it, expect } from 'vitest'
import { createMemoryDataStore } from './memory.js'
import { describeDataStore } from './conformance.js'
import { OptimisticConflictError } from './index.js'

// Run the dev in-memory store through the shared conformance suite.
//
// The default memory store hard-deletes (softDelete capability OFF); a second
// run exercises the soft-delete tombstone path. The memory store is
// full-featured otherwise (optimistic concurrency, filter, pagination).
describeDataStore(() => createMemoryDataStore(), { softDelete: false })
describeDataStore(() => createMemoryDataStore({ softDelete: true }), {
  softDelete: true,
})

// A couple of memory-specific assertions not covered by the generic suite.
describe('MemoryDataStore specifics', () => {
  it('count honors scope and equality filter', async () => {
    const store = createMemoryDataStore()
    const a = { tenantId: 'A' }
    await store.create('1', { id: '1', name: 'x', kind: 'red' }, a)
    await store.create('2', { id: '2', name: 'y', kind: 'red' }, a)
    await store.create('3', { id: '3', name: 'z', kind: 'blue' }, a)
    await store.create('9', { id: '9', name: 'q', kind: 'red' }, { tenantId: 'B' })
    expect(await store.count!({}, a)).toBe(3)
    expect(await store.count!({ filter: { kind: 'red' } }, a)).toBe(2)
  })

  it('patch respects the expected version', async () => {
    const store = createMemoryDataStore()
    await store.create('a', { id: 'a', name: 'v1' }, {})
    await expect(store.patch('a', { name: 'v2' }, 99, {})).rejects.toBeInstanceOf(
      OptimisticConflictError,
    )
    const ok = await store.patch('a', { name: 'v2' }, 1, {})
    expect(ok.version).toBe(2)
  })

  it('ignores a caller-injected deletedAt so it cannot forge a tombstone', async () => {
    // softDelete OFF: an injected `deletedAt` must NOT make a live row invisible
    // to get/list/count nor strand the key as an unaddressable zombie.
    const store = createMemoryDataStore<{ id: string; name: string; deletedAt?: string }>()
    const scope = {}

    const created = await store.create(
      '1',
      { id: '1', name: 'live', deletedAt: '2020-01-01T00:00:00Z' },
      scope,
    )
    expect(created.deletedAt).toBeUndefined()
    // Visible everywhere despite the injected tombstone field.
    expect(await store.get('1', scope)).not.toBeNull()
    expect(await store.count!({}, scope)).toBe(1)
    const page = await store.list({ limit: 10 }, scope)
    expect(page.items.map((i) => i.id)).toEqual(['1'])

    // put / update / patch must also strip it.
    await store.put('1', { id: '1', name: 'p', deletedAt: '2020-01-01T00:00:00Z' }, scope)
    expect(await store.get('1', scope)).not.toBeNull()
    const patched = await store.patch(
      '1',
      { name: 'q', deletedAt: '2020-01-01T00:00:00Z' },
      undefined,
      scope,
    )
    expect(patched.deletedAt).toBeUndefined()
    expect(await store.get('1', scope)).not.toBeNull()
  })

  it('soft-deleted key can be re-created (create succeeds over a tombstone)', async () => {
    const store = createMemoryDataStore({ softDelete: true })
    await store.create('a', { id: 'a', name: 'v1' }, {})
    await store.delete('a', undefined, {})
    const recreated = await store.create('a', { id: 'a', name: 'v2' }, {})
    expect(recreated.name).toBe('v2')
    expect((await store.get('a', {}))!.name).toBe('v2')
  })
})
