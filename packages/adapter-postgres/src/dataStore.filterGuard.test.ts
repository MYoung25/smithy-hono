/**
 * Regression for the undeclared-filter defense-in-depth guard (SECRETS-DATA-SQL-06):
 * a `list` on a non-declared index WARNS (and still runs), while a `count` on a
 * non-declared index REFUSES (an exact count can't be silently capped without
 * lying). Mirrors adapter-node (warn) and adapter-aws (count refusal). Declared
 * `@persisted(indexes)` fields are allowed for both.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createPostgresDataStore,
  createFakePgDataPort,
  createPgDataPort,
  type PgClientLike,
} from './dataStore.js'

interface Row extends Record<string, unknown> {
  id: string
  kind: string
}

const NO_SCOPE = {}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('undeclared-filter guard', () => {
  it('count REFUSES an undeclared filter field', async () => {
    const store = createPostgresDataStore<Row>(createFakePgDataPort(), {
      indexes: ['kind'],
    })
    await store.create('a', { id: 'a', kind: 'red' }, NO_SCOPE)
    await expect(store.count!({ filter: { owner: 'x' } }, NO_SCOPE)).rejects.toThrow(
      /non-declared index/,
    )
  })

  it('count ALLOWS a declared filter field', async () => {
    const store = createPostgresDataStore<Row>(createFakePgDataPort(), {
      indexes: ['kind'],
    })
    await store.create('a', { id: 'a', kind: 'red' }, NO_SCOPE)
    await store.create('b', { id: 'b', kind: 'blue' }, NO_SCOPE)
    expect(await store.count!({ filter: { kind: 'red' } }, NO_SCOPE)).toBe(1)
  })

  it('count with no filter is always allowed', async () => {
    const store = createPostgresDataStore<Row>(createFakePgDataPort(), {})
    await store.create('a', { id: 'a', kind: 'red' }, NO_SCOPE)
    expect(await store.count!({}, NO_SCOPE)).toBe(1)
  })

  it('list WARNS but still runs on an undeclared filter field', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createPostgresDataStore<Row>(createFakePgDataPort(), {
      indexes: ['kind'],
    })
    await store.create('a', { id: 'a', kind: 'red' }, NO_SCOPE)
    const page = await store.list({ limit: 100, filter: { kind: 'red', owner: 'x' } }, NO_SCOPE)
    // The declared field still filters; the warning names the undeclared one.
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toMatch(/non-declared index owner/)
    expect(page.items.map((i) => i.id)).toEqual([]) // owner='x' matches nothing
  })

  it('list does NOT warn when all filter fields are declared', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createPostgresDataStore<Row>(createFakePgDataPort(), {
      indexes: ['kind'],
    })
    await store.create('a', { id: 'a', kind: 'red' }, NO_SCOPE)
    await store.list({ limit: 100, filter: { kind: 'red' } }, NO_SCOPE)
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('statement_timeout (real port SQL shape)', () => {
  const runQuery = (text: string) => {
    // COUNT(*) returns a row with `n`; everything else returns no rows.
    const rows = /COUNT\(\*\)/.test(text) ? [{ n: 0 }] : []
    return { rows, rowCount: 0 }
  }

  /** A bare `query()`-only client (no pool checkout). */
  function bareClient(): { client: PgClientLike; texts: string[] } {
    const texts: string[] = []
    const client: PgClientLike = {
      async query(text: string) {
        texts.push(text)
        return runQuery(text)
      },
    }
    return { client, texts }
  }

  /**
   * A pool-shaped client exposing `connect()`. Tracks which texts ran on a
   * checked-out connection vs the bare pool, and whether the connection was
   * released (and with what error).
   */
  function poolClient(): {
    client: PgClientLike
    connTexts: string[]
    released: number
    releaseErrs: unknown[]
  } {
    const connTexts: string[] = []
    const state = { released: 0, releaseErrs: [] as unknown[] }
    const client: PgClientLike = {
      async query(text: string) {
        return runQuery(text)
      },
      async connect() {
        return {
          async query(text: string) {
            connTexts.push(text)
            return runQuery(text)
          },
          release(err?: unknown) {
            state.released++
            if (err !== undefined) state.releaseErrs.push(err)
          },
        }
      },
    }
    return {
      client,
      connTexts,
      get released() {
        return state.released
      },
      get releaseErrs() {
        return state.releaseErrs
      },
    }
  }

  it('runs the timeout-scoped read on ONE checked-out connection when connect() exists', async () => {
    const pc = poolClient()
    const port = createPgDataPort(pc.client, 'data_store', { statementTimeoutMs: 1500 })
    await port.count('scope', undefined, false)
    // BEGIN / SET LOCAL / read / COMMIT all landed on the SAME dedicated conn.
    expect(pc.connTexts).toEqual([
      'BEGIN',
      'SET LOCAL statement_timeout = 1500',
      expect.stringContaining('COUNT(*)'),
      'COMMIT',
    ])
    expect(pc.released).toBe(1)
    expect(pc.releaseErrs).toEqual([]) // clean release on success
  })

  it('releases the connection WITH the error on the failure path', async () => {
    const connTexts: string[] = []
    let released = 0
    let releaseErr: unknown
    const boom = new Error('read failed')
    const client: PgClientLike = {
      async query() {
        return { rows: [], rowCount: 0 }
      },
      async connect() {
        return {
          async query(text: string) {
            connTexts.push(text)
            if (/COUNT\(\*\)/.test(text)) throw boom
            return { rows: [], rowCount: 0 }
          },
          release(err?: unknown) {
            released++
            releaseErr = err
          },
        }
      },
    }
    const port = createPgDataPort(client, 'data_store', { statementTimeoutMs: 1500 })
    await expect(port.count('scope', undefined, false)).rejects.toBe(boom)
    expect(released).toBe(1)
    expect(releaseErr).toBe(boom) // pool discards the in-transaction connection
  })

  it('falls back to a plain untimed read for a bare query()-only client', async () => {
    const { client, texts } = bareClient()
    const port = createPgDataPort(client, 'data_store', { statementTimeoutMs: 1500 })
    await port.count('scope', undefined, false)
    // No BEGIN/SET LOCAL across pooled queries (that would silently drop the
    // timeout and leak an idle-in-transaction connection); just the read.
    expect(texts).toEqual([expect.stringContaining('COUNT(*)')])
  })

  it('issues no transaction when no timeout is configured', async () => {
    const { client, texts } = bareClient()
    const port = createPgDataPort(client, 'data_store')
    await port.count('scope', undefined, false)
    expect(texts).toEqual([expect.stringContaining('COUNT(*)')])
  })
})
