/**
 * Focused regression tests for the two adapter-cf DataStore defense-in-depth
 * guards closed in round 2:
 *
 *   - SECRETS-DATA-SQL-05: the KV store tolerates a corrupt / wrong-shaped KV
 *     value (KV is writable out-of-band) — a poisoned key is treated as ABSENT
 *     (skipped in `list`, null in `get`) instead of throwing a raw SyntaxError.
 *   - SECRETS-DATA-SQL-06: the D1 store mirrors adapter-node / adapter-aws by
 *     WARNING on a `list` filtered by a non-declared index and REFUSING a `count`
 *     on one (D1 has no statement_timeout, so the count refusal is the lever).
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createD1DataStore,
  createFakeD1DataPort,
  createKvDataStore,
} from './dataStore.js'
import { FakeKvNamespace } from './test-support.js'

const SCOPE = { tenantId: 't1', ownerId: 'o1' }

afterEach(() => {
  vi.restoreAllMocks()
})

// --- SECRETS-DATA-SQL-05: corrupt KV row is ABSENT, never a thrown SyntaxError.
describe('KvDataStore — corrupt / wrong-shaped KV value is treated as absent', () => {
  it('get() returns null for invalid JSON instead of throwing', async () => {
    const kv = new FakeKvNamespace()
    const store = createKvDataStore<{ a: string }>(kv, { prefix: 'ds:' })
    // Poison the exact key the store reads (prefix + length-prefixed scope | id).
    const key = `ds:2:t1|2:o1|k1`
    await kv.put(key, '{ not json')
    await expect(store.get('k1', SCOPE)).resolves.toBeNull()
  })

  it('get() returns null for valid JSON of the wrong shape (no version)', async () => {
    const kv = new FakeKvNamespace()
    const store = createKvDataStore<{ a: string }>(kv, { prefix: 'ds:' })
    await kv.put(`ds:2:t1|2:o1|k1`, JSON.stringify({ value: { a: '1' } }))
    await expect(store.get('k1', SCOPE)).resolves.toBeNull()
  })

  it('list() skips a poisoned row and still returns the healthy ones', async () => {
    const kv = new FakeKvNamespace()
    const store = createKvDataStore<{ a: string }>(kv, { prefix: 'ds:' })
    await store.create('good1', { a: '1' }, SCOPE)
    await store.create('good2', { a: '2' }, SCOPE)
    // Inject a corrupt row between the good ones (sorted: good1, good2, zbad).
    await kv.put(`ds:2:t1|2:o1|zbad`, 'totally-not-json')
    const page = await store.list({ limit: 50 }, SCOPE)
    const ids = page.items.map((i) => (i as { a: string }).a).sort()
    expect(ids).toEqual(['1', '2'])
  })
})

// --- SECRETS-DATA-SQL-06: undeclared-filter warn (list) + refuse (count).
describe('D1DataStore — undeclared-filter guard (warn on list, refuse on count)', () => {
  it('list() warns when filtering on a non-declared index', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createD1DataStore(createFakeD1DataPort(), { indexes: ['kind'] })
    await store.list({ limit: 10, filter: { color: 'red' } }, SCOPE)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(
      /non-declared index color via a full server-side scope scan/,
    )
  })

  it('list() does NOT warn when filtering on a declared index', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createD1DataStore(createFakeD1DataPort(), { indexes: ['kind'] })
    await store.list({ limit: 10, filter: { kind: 'a' } }, SCOPE)
    expect(warn).not.toHaveBeenCalled()
  })

  it('count() refuses an exact count on a non-declared index', async () => {
    const store = createD1DataStore(createFakeD1DataPort(), { indexes: ['kind'] })
    // `count` is optional on DataStore (capability-graded); the D1 store always
    // implements it — which is exactly what these guards assert — so assert non-null.
    await expect(store.count!({ filter: { color: 'red' } }, SCOPE)).rejects.toThrow(
      /an exact count on a non-declared index \(color\)/,
    )
  })

  it('count() allows an exact count on a declared index', async () => {
    const store = createD1DataStore(createFakeD1DataPort(), { indexes: ['kind'] })
    await expect(store.count!({ filter: { kind: 'a' } }, SCOPE)).resolves.toBe(0)
  })

  it('count() with no filter is unaffected', async () => {
    const store = createD1DataStore(createFakeD1DataPort(), { indexes: ['kind'] })
    await expect(store.count!({}, SCOPE)).resolves.toBe(0)
  })
})

// --- KV list scan budget: a tombstone/corrupt-heavy scope must not issue an
// unbounded number of per-key GET subrequests (Workers subrequest ceiling).
describe('KvDataStore — list() bounds per-key GETs by a scan budget', () => {
  it('stops after ~limit*10 dropped keys and returns a resume cursor', async () => {
    const kv = new FakeKvNamespace()
    let gets = 0
    const counting = new Proxy(kv, {
      get(target, prop, receiver) {
        if (prop === 'get') {
          return (key: string) => {
            gets++
            return target.get(key)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const store = createKvDataStore<{ a: string }>(counting, { prefix: 'ds:' })
    // 30 corrupt (absent) rows and NO live row: each costs one GET that does not
    // fill the page. With limit=1 the budget is 1*10=10, so list must stop early.
    for (let i = 0; i < 30; i++) {
      const n = String(i).padStart(2, '0')
      await kv.put(`ds:2:t1|2:o1|k${n}`, 'not-json')
    }
    const page = await store.list({ limit: 1 }, SCOPE)
    expect(page.items).toEqual([])
    // Budget capped the GETs well below the 30 present keys.
    expect(gets).toBeLessThanOrEqual(10)
    // A resume cursor is emitted so the caller can continue past the budget.
    expect(page.cursor).toBeDefined()
  })
})
