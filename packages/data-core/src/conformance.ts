/**
 * Shared, reusable {@link DataStore} conformance suite (Plan 13).
 *
 * Any implementation of {@link DataStore} — the dev in-memory one here, and the
 * adapter packages (Redis / DynamoDB / D1 / KV) — MUST pass this suite. Adapters
 * import {@link describeDataStore} and call it against a freshly-constructed
 * store; that's how we keep behavioral parity across backends.
 *
 * Backends differ in what they can do (KV can't filter; some can't soft-delete),
 * so each declares a {@link DataStoreCapabilities} descriptor and assertions for
 * unsupported features are **skipped** (`it.skip`), never failed.
 *
 * This file imports only `vitest` (a Web-standard-agnostic test runner) — no
 * `node:*` (ARCH-01).
 */

import { describe, it, expect } from 'vitest'
import { OptimisticConflictError, type DataStore } from './index.js'

/** A store factory: returns a fresh, isolated instance per test. */
export type Factory<T> = () => T | Promise<T>

/**
 * What a backend can do. Unset/`false` flags skip the matching assertions rather
 * than failing them. Defaults assume a full-featured store (memory / SQL).
 */
export interface DataStoreCapabilities {
  /** Honors `expectedVersion` and throws {@link OptimisticConflictError} on stale writes. */
  optimisticConcurrency?: boolean
  /** Tombstones on delete and hides tombstoned rows from get/list. */
  softDelete?: boolean
  /** Supports the equality `filter` on `list`. */
  filter?: boolean
  /** Supports opaque-cursor pagination on `list`. */
  pagination?: boolean
}

const DEFAULTS: Required<DataStoreCapabilities> = {
  optimisticConcurrency: true,
  softDelete: true,
  filter: true,
  pagination: true,
}

/**
 * A trivial entity shape used by the suite. Exported so adapter conformance
 * tests can type their store factories as `DataStore<Item>` — `DataStore<T>` is
 * invariant in `T` (it both consumes and produces `T`), so a factory that
 * infers `DataStore<Record<string, unknown>>` is NOT assignable to the
 * `Factory<DataStore<Item>>` this harness expects.
 */
export interface Item extends Record<string, unknown> {
  id: string
  name: string
  kind?: string
}

const NO_SCOPE = {}

/**
 * Register the {@link DataStore} conformance suite for one backend.
 *
 * @param makeStore  fresh-store factory (called once per test).
 * @param capabilities  what this backend supports; unsupported assertions skip.
 */
export function describeDataStore(
  makeStore: Factory<DataStore<Item>>,
  capabilities: DataStoreCapabilities = {},
): void {
  const caps = { ...DEFAULTS, ...capabilities }
  const name = makeStore.name && makeStore.name !== 'makeStore' ? makeStore.name : 'DataStore'

  describe(`DataStore conformance: ${name}`, () => {
    it('returns null for an unknown key', async () => {
      const store = await makeStore()
      expect(await store.get('missing', NO_SCOPE)).toBeNull()
    })

    it('create then get (read-after-write) with version=1', async () => {
      const store = await makeStore()
      const saved = await store.create('a', { id: 'a', name: 'Ada' }, NO_SCOPE)
      expect(saved.version).toBe(1)
      expect(saved.name).toBe('Ada')
      const got = await store.get('a', NO_SCOPE)
      expect(got).not.toBeNull()
      expect(got!.id).toBe('a')
      expect(got!.version).toBe(1)
    })

    it('create fails if the key already exists', async () => {
      const store = await makeStore()
      await store.create('a', { id: 'a', name: 'Ada' }, NO_SCOPE)
      await expect(
        store.create('a', { id: 'a', name: 'Other' }, NO_SCOPE),
      ).rejects.toThrow()
    })

    it('put is an unconditional upsert and bumps the version', async () => {
      const store = await makeStore()
      const first = await store.put('a', { id: 'a', name: 'v1' }, NO_SCOPE)
      expect(first.version).toBe(1)
      const second = await store.put('a', { id: 'a', name: 'v2' }, NO_SCOPE)
      expect(second.version).toBe(2)
      expect((await store.get('a', NO_SCOPE))!.name).toBe('v2')
    })

    it('update bumps the version on a full replace', async () => {
      const store = await makeStore()
      await store.create('a', { id: 'a', name: 'v1' }, NO_SCOPE)
      const updated = await store.update('a', { id: 'a', name: 'v2' }, undefined, NO_SCOPE)
      expect(updated.version).toBe(2)
      expect(updated.name).toBe('v2')
    })

    it('patch merges and bumps the version', async () => {
      const store = await makeStore()
      await store.create('a', { id: 'a', name: 'v1', kind: 'x' }, NO_SCOPE)
      const patched = await store.patch('a', { name: 'v2' }, undefined, NO_SCOPE)
      expect(patched.version).toBe(2)
      expect(patched.name).toBe('v2')
      expect(patched.kind).toBe('x') // untouched field preserved
    })

    it('delete returns true then false (idempotent miss)', async () => {
      const store = await makeStore()
      await store.create('a', { id: 'a', name: 'Ada' }, NO_SCOPE)
      expect(await store.delete('a', undefined, NO_SCOPE)).toBe(true)
      expect(await store.get('a', NO_SCOPE)).toBeNull()
      expect(await store.delete('a', undefined, NO_SCOPE)).toBe(false)
    })

    const itOcc = caps.optimisticConcurrency ? it : it.skip
    itOcc('update throws OptimisticConflictError on a stale version', async () => {
      const store = await makeStore()
      await store.create('a', { id: 'a', name: 'v1' }, NO_SCOPE) // version 1
      await store.update('a', { id: 'a', name: 'v2' }, 1, NO_SCOPE) // → version 2
      await expect(
        store.update('a', { id: 'a', name: 'v3' }, 1, NO_SCOPE), // stale
      ).rejects.toBeInstanceOf(OptimisticConflictError)
    })

    itOcc('update with the matching version succeeds', async () => {
      const store = await makeStore()
      await store.create('a', { id: 'a', name: 'v1' }, NO_SCOPE)
      const ok = await store.update('a', { id: 'a', name: 'v2' }, 1, NO_SCOPE)
      expect(ok.version).toBe(2)
    })

    itOcc('patch throws OptimisticConflictError on a stale version', async () => {
      const store = await makeStore()
      await store.create('a', { id: 'a', name: 'v1' }, NO_SCOPE) // version 1
      await store.update('a', { id: 'a', name: 'v2' }, 1, NO_SCOPE) // → version 2
      await expect(
        store.patch('a', { name: 'v3' }, 1, NO_SCOPE), // stale
      ).rejects.toBeInstanceOf(OptimisticConflictError)
    })

    itOcc('delete throws OptimisticConflictError on a stale version', async () => {
      const store = await makeStore()
      await store.create('a', { id: 'a', name: 'v1' }, NO_SCOPE)
      await store.update('a', { id: 'a', name: 'v2' }, undefined, NO_SCOPE) // → version 2
      await expect(
        store.delete('a', 1, NO_SCOPE),
      ).rejects.toBeInstanceOf(OptimisticConflictError)
    })

    const itSoft = caps.softDelete ? it : it.skip
    itSoft('a soft-deleted entity becomes invisible to get and list', async () => {
      const store = await makeStore()
      await store.create('a', { id: 'a', name: 'Ada' }, NO_SCOPE)
      expect(await store.delete('a', undefined, NO_SCOPE)).toBe(true)
      expect(await store.get('a', NO_SCOPE)).toBeNull()
      const page = await store.list({ limit: 100 }, NO_SCOPE)
      expect(page.items.find((i) => i.id === 'a')).toBeUndefined()
    })

    itSoft('create over a soft-delete tombstone resurrects LIVE and CONTINUES the version', async () => {
      const store = await makeStore()
      await store.create('a', { id: 'a', name: 'v1' }, NO_SCOPE) // version 1
      await store.update('a', { id: 'a', name: 'v2' }, undefined, NO_SCOPE) // → version 2
      expect(await store.delete('a', undefined, NO_SCOPE)).toBe(true) // soft-delete tombstone
      // Resurrect via create: version CONTINUES (strictly > the pre-delete v2), it does
      // NOT reset to 1. Backends may either retain or bump the version on soft-delete, so
      // assert "continued" (> pre-delete), not an exact number.
      const resurrected = await store.create('a', { id: 'a', name: 'v3' }, NO_SCOPE)
      expect(resurrected.version).toBeGreaterThan(2)
      const got = await store.get('a', NO_SCOPE)
      expect(got).not.toBeNull() // live + readable again
      expect(got!.name).toBe('v3')
      expect(got!.version).toBeGreaterThan(2) // continued, not reset to 1
    })

    itSoft('put over a soft-delete tombstone resurrects LIVE and CONTINUES the version', async () => {
      const store = await makeStore()
      await store.create('a', { id: 'a', name: 'v1' }, NO_SCOPE) // version 1
      await store.update('a', { id: 'a', name: 'v2' }, undefined, NO_SCOPE) // → version 2
      expect(await store.delete('a', undefined, NO_SCOPE)).toBe(true) // soft-delete tombstone
      // Resurrect via put: version CONTINUES (strictly > the pre-delete v2), not reset to 1.
      const resurrected = await store.put('a', { id: 'a', name: 'v3' }, NO_SCOPE)
      expect(resurrected.version).toBeGreaterThan(2)
      const got = await store.get('a', NO_SCOPE)
      expect(got).not.toBeNull() // live + readable again
      expect(got!.name).toBe('v3')
      expect(got!.version).toBeGreaterThan(2) // continued, not reset to 1
    })

    it('isolates scopes: tenant A cannot read tenant B', async () => {
      const store = await makeStore()
      const a = { tenantId: 'A' }
      const b = { tenantId: 'B' }
      await store.create('shared', { id: 'shared', name: 'A-owned' }, a)
      // Same key, different tenant → invisible (existence hiding).
      expect(await store.get('shared', b)).toBeNull()
      const got = await store.get('shared', a)
      expect(got!.name).toBe('A-owned')
      // B can create its own row at the same key without colliding.
      const bRow = await store.create('shared', { id: 'shared', name: 'B-owned' }, b)
      expect(bRow.name).toBe('B-owned')
      expect((await store.get('shared', a))!.name).toBe('A-owned') // A's row intact
    })

    it('list scopes results to the requesting scope', async () => {
      const store = await makeStore()
      const a = { tenantId: 'A' }
      const b = { tenantId: 'B' }
      await store.create('1', { id: '1', name: 'a1' }, a)
      await store.create('2', { id: '2', name: 'a2' }, a)
      await store.create('1', { id: '1', name: 'b1' }, b)
      const pageA = await store.list({ limit: 100 }, a)
      expect(pageA.items).toHaveLength(2)
      expect(pageA.items.every((i) => i.name.startsWith('a'))).toBe(true)
    })

    it('isolates scopes across ALL mutating methods: B cannot affect A', async () => {
      const store = await makeStore()
      const a = { tenantId: 'A' }
      const b = { tenantId: 'B' }
      await store.create('shared', { id: 'shared', name: 'A-owned' }, a) // A's row, version 1

      // B attempts every mutating method against the same key. Whether each
      // throws or no-ops is backend-specific; the invariant we pin is that A's
      // row is OBSERVABLY UNAFFECTED — never another tenant's data leaking in.
      await store.update('shared', { id: 'shared', name: 'B-hijack' }, undefined, b).catch(() => {})
      await store.patch('shared', { name: 'B-hijack' }, undefined, b).catch(() => {})
      await store.delete('shared', undefined, b).catch(() => {})
      if (typeof store.count === 'function') {
        await store.count({}, b).catch(() => {})
      }

      const got = await store.get('shared', a)
      expect(got).not.toBeNull()
      expect(got!.name).toBe('A-owned') // value untouched
      expect(got!.version).toBe(1) // version untouched
    })

    it('count reflects scope, filter, and excludes tombstones', async () => {
      const store = await makeStore()
      if (typeof store.count !== 'function') return // capability-graded
      const a = { tenantId: 'A' }
      const b = { tenantId: 'B' }
      await store.create('1', { id: '1', name: 'x', kind: 'red' }, a)
      await store.create('2', { id: '2', name: 'y', kind: 'red' }, a)
      await store.create('3', { id: '3', name: 'z', kind: 'blue' }, a)
      await store.create('9', { id: '9', name: 'q', kind: 'red' }, b) // other scope

      expect(await store.count({}, a)).toBe(3) // scoped to A
      if (caps.filter) {
        expect(await store.count({ filter: { kind: 'red' } }, a)).toBe(2) // + equality filter
      }
      if (caps.softDelete) {
        await store.delete('1', undefined, a) // tombstone one of the reds
        expect(await store.count({}, a)).toBe(2) // tombstone excluded
        if (caps.filter) {
          expect(await store.count({ filter: { kind: 'red' } }, a)).toBe(1)
        }
      }
    })

    it('list throws on a non-positive limit (0 and negative)', async () => {
      const store = await makeStore()
      await store.create('a', { id: 'a', name: 'Ada' }, NO_SCOPE)
      // limit:0 would silently make all data unreachable — fail fast instead.
      await expect(store.list({ limit: 0 }, NO_SCOPE)).rejects.toThrow()
      await expect(store.list({ limit: -1 }, NO_SCOPE)).rejects.toThrow()
    })

    const itPage = caps.pagination ? it : it.skip
    itPage('paginates with an opaque cursor that is not an offset', async () => {
      const store = await makeStore()
      for (let i = 0; i < 5; i++) {
        await store.create(`k${i}`, { id: `k${i}`, name: `n${i}` }, NO_SCOPE)
      }
      const seen = new Set<string>()
      let cursor: string | undefined
      let pages = 0
      do {
        const page = await store.list({ limit: 2, cursor }, NO_SCOPE)
        for (const item of page.items) seen.add(item.id)
        expect(page.items.length).toBeLessThanOrEqual(2)
        cursor = page.cursor
        pages++
        expect(pages).toBeLessThan(10) // guard against a non-terminating cursor
      } while (cursor)
      expect(seen.size).toBe(5) // every row seen exactly once across pages
    })

    itPage('cursor is opaque (not a parseable integer offset)', async () => {
      const store = await makeStore()
      for (let i = 0; i < 3; i++) {
        await store.create(`k${i}`, { id: `k${i}`, name: `n${i}` }, NO_SCOPE)
      }
      const page = await store.list({ limit: 1 }, NO_SCOPE)
      expect(page.cursor).toBeDefined()
      // An opaque token must not be a bare offset like "1".
      expect(/^\d+$/.test(page.cursor!)).toBe(false)
    })

    const itFilter = caps.filter ? it : it.skip
    itFilter('filters by equality', async () => {
      const store = await makeStore()
      await store.create('1', { id: '1', name: 'a', kind: 'red' }, NO_SCOPE)
      await store.create('2', { id: '2', name: 'b', kind: 'blue' }, NO_SCOPE)
      await store.create('3', { id: '3', name: 'c', kind: 'red' }, NO_SCOPE)
      const page = await store.list({ limit: 100, filter: { kind: 'red' } }, NO_SCOPE)
      expect(page.items.map((i) => i.id).sort()).toEqual(['1', '3'])
    })

    itFilter('filter reflects updates (no stale index)', async () => {
      const store = await makeStore()
      await store.create('1', { id: '1', name: 'a', kind: 'red' }, NO_SCOPE)
      // Move it from kind=red to kind=blue via a full replace.
      await store.update('1', { id: '1', name: 'a', kind: 'blue' }, undefined, NO_SCOPE)

      const reds = await store.list({ limit: 100, filter: { kind: 'red' } }, NO_SCOPE)
      expect(reds.items.find((i) => i.id === '1')).toBeUndefined() // no longer red
      const blues = await store.list({ limit: 100, filter: { kind: 'blue' } }, NO_SCOPE)
      expect(blues.items.find((i) => i.id === '1')).toBeDefined() // now blue
    })

    itPage('pagination survives deletion of the cursor anchor', async () => {
      const store = await makeStore()
      const total = 5
      for (let i = 0; i < total; i++) {
        await store.create(`k${i}`, { id: `k${i}`, name: `n${i}` }, NO_SCOPE)
      }

      // First page (small limit) yields a cursor; the LAST row it returned is
      // the anchor the cursor encodes.
      const first = await store.list({ limit: 2 }, NO_SCOPE)
      expect(first.cursor).toBeDefined()
      const seen = new Set(first.items.map((i) => i.id))
      const anchor = first.items[first.items.length - 1]!.id

      // Hard-delete the anchor between pages, then keep paginating. A
      // delete-via-tombstone backend won't truly remove the key, so force the
      // hard-delete case only where the store actually hard-deletes.
      await store.delete(anchor, undefined, NO_SCOPE)
      const anchorGone = (await store.get(anchor, NO_SCOPE)) === null
      const deletedAnchor = anchorGone ? anchor : undefined

      let cursor = first.cursor
      let pages = 1
      while (cursor) {
        const page = await store.list({ limit: 2, cursor }, NO_SCOPE)
        for (const item of page.items) {
          expect(seen.has(item.id)).toBe(false) // no duplicates across pages
          seen.add(item.id)
        }
        cursor = page.cursor
        pages++
        expect(pages).toBeLessThan(20) // guard against a non-terminating cursor
      }

      // Every still-existing row is seen exactly once — no gaps from the
      // deleted anchor. (The deleted anchor itself was already in `seen` from
      // page one, so it counts toward the total either way.)
      expect(seen.size).toBe(total)
      if (deletedAnchor) {
        // The anchor was seen on page one; nothing after it was dropped.
        expect(seen.has(deletedAnchor)).toBe(true)
      }
    })
  })
}
