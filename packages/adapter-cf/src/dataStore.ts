/**
 * `DataStore<T>` (Plan 13 — default DB-backed CRUD) over Cloudflare D1 + KV,
 * each behind a narrow structural port (ARCH-01).
 *
 * Two backends, two very different capability grades — exactly as the plan's
 * "## Adapters → adapter-cf" bullet prescribes:
 *
 *   - **D1 (SQL) — the primary, full-featured store** ({@link createD1DataStore}).
 *     D1 gives strongly-consistent, transactional SQL, so it supports the WHOLE
 *     {@link DataStore} contract: optimistic concurrency (a conditional `UPDATE
 *     ... WHERE key=? AND version=?` whose `rowsAffected` we inspect), rich
 *     equality `filter` + `count` via `WHERE` clauses, soft-delete tombstones,
 *     and opaque-cursor pagination. Like the security stores it never imports a
 *     Cloudflare SDK: the consumer's real `D1Database` binding structurally
 *     satisfies {@link D1DatabaseLike}, and all store logic runs against a narrow
 *     SEMANTIC port ({@link D1DataPort}) — never raw SQL — so the conformance
 *     fake reimplements the semantics in JS with no SQL parser.
 *
 *   - **KV — a key-access SUBSET, fail-fast** ({@link createKvDataStore}). Workers
 *     KV is eventually consistent and has NO atomic compare-and-set, so it CANNOT
 *     do a safe versioned update — the same reason `RATE`/nonce "MUST NOT use KV"
 *     (see `ports.ts:26-30`). So {@link createKvDataStore} FAILS FAST at
 *     construction if `optimisticConcurrency` is requested, and declares
 *     `{ optimisticConcurrency: false, filter: false }` to the conformance suite
 *     (KV can't equality-filter opaque values, but its native prefix `list()`
 *     gives real opaque-cursor pagination). `update`/`patch` are best-effort
 *     read-then-unconditional-put (last-write-wins, version bumped but NOT
 *     guarded) — documented below.
 *
 * **Durable Objects:** the plan lists "Durable Objects for strong-consistency
 * writes". D1 ALREADY provides strongly-consistent, version-guarded writes (the
 * SQL CAS below), which is precisely that concern — so a separate DO-backed
 * DataStore would be redundant and is intentionally NOT built. D1 is the
 * strong-consistency write path for the CF adapter; KV is the eventually-
 * consistent key-access subset. (DOs remain the right tool for the *security*
 * rate-limit/nonce serial-counter concern, which is not a CRUD DataStore.)
 *
 * Storage model (D1, one entity = one row):
 *   - table {@link D1_TABLE_DEFAULT} (override via `opts.table`), columns:
 *     `scope` (length-prefixed {@link DataScope}), `id` (the entity key),
 *     `value` (the JSON entity), `version` (the optimistic-concurrency token),
 *     `deleted_at` (tombstone, only written when `softDelete`). PRIMARY KEY is
 *     `(scope, id)`, so tenant A literally cannot address tenant B's rows
 *     (cross-scope `get` → null), and the same key in two scopes never collides.
 *   - Declared `@persisted(indexes)` map to indexed expressions over the JSON so
 *     a filtered `list`/`count` stays a server-side `WHERE` (no client scan,
 *     unlike Redis). See {@link d1CreateTableSql} for the migration the consumer
 *     runs.
 */

import {
  OptimisticConflictError,
  type DataScope,
  type DataStore,
  type ListQuery,
  type Page,
  type Stored,
} from '@smithy-hono/data-core'
import type { KvNamespaceLike } from './ports.js'

// ---------------------------------------------------------------------------
// Shared scope + cursor helpers (mirror the adapter-node DataStore exactly).
// ---------------------------------------------------------------------------

/** Length-prefixed scope segment (collision-proof, mirrors the other adapters). */
function scopeSeg(scope: DataScope): string {
  const t = scope.tenantId ?? ''
  const o = scope.ownerId ?? ''
  return `${t.length}:${t}|${o.length}:${o}`
}

/** Opaque base64 cursor of the last entity key emitted — NEVER an offset. */
function encodeCursor(lastKey: string): string {
  return btoa(unescape(encodeURIComponent(lastKey)))
}
function decodeCursor(cursor: string): string {
  return decodeURIComponent(escape(atob(cursor)))
}

/** Equality-only filter match (every declared field must equal). */
function matchesFilter<T>(
  stored: Stored<T>,
  filter: Record<string, string | number | boolean> | undefined,
): boolean {
  if (!filter) return true
  for (const [field, want] of Object.entries(filter)) {
    if ((stored as Record<string, unknown>)[field] !== want) return false
  }
  return true
}

// ===========================================================================
// PART 1 — D1 (SQL) DataStore: primary, full-featured.
// ===========================================================================

// ---------------------------------------------------------------------------
// D1DataPort — the narrow SEMANTIC surface the D1 store depends on.
//
// Like adapter-node's RedisDataPort (hget/smembers/evalCas, NOT raw commands),
// these are SEMANTIC operations — never raw SQL — so the fake port reimplements
// them over a Map with no SQL parser. The REAL port (createD1DataPort) is the
// only place that speaks SQL.
// ---------------------------------------------------------------------------

/** A persisted row as the port exchanges it (the store owns the JSON shape). */
export interface D1Row {
  /** The entity key (the resource identifier). */
  id: string
  /** The JSON-serialized entity (without the store-managed `version`). */
  value: string
  /** The optimistic-concurrency version. */
  version: number
  /** ISO tombstone timestamp, or `null` for a live row. */
  deletedAt: string | null
}

/** A query the D1 port resolves server-side (the store never builds SQL). */
export interface D1ListArgs {
  /** Max rows to return (the store asks for `limit + 1` to detect more pages). */
  limit: number
  /** Exclusive lower bound on `id` (the decoded cursor), or undefined for the start. */
  after?: string
  /** Equality filter over JSON fields (resolved as `json_extract` predicates). */
  filter?: Record<string, string | number | boolean>
  /** When true, tombstoned rows are excluded (soft-delete stores). */
  excludeDeleted: boolean
}

/**
 * The minimal SEMANTIC port {@link D1DataStore} uses. Implementations MUST
 * preserve the atomicity of {@link updateCas} / {@link deleteCas} (the
 * versioned read-compare-write) and the create-if-absent of {@link insertIfAbsent}.
 */
export interface D1DataPort {
  /** Fetch one row by `(scope, id)`, or `null`. Tombstones are returned (the store hides them). */
  getRow(scope: string, id: string): Promise<D1Row | null>
  /**
   * Create-if-absent. Returns the resulting version on a successful insert, or
   * `0` if a LIVE row already existed at `(scope, id)` (atomic `INSERT ... ON
   * CONFLICT DO NOTHING`). When `allowOverTombstone`, a tombstoned row is
   * resurrected and the version CONTINUES from the tombstone (tombstone.version
   * + 1), never reset to 1 — a fresh insert is version 1.
   */
  insertIfAbsent(scope: string, row: D1Row, allowOverTombstone: boolean): Promise<number>
  /** Unconditional upsert (idempotent `put`). Returns the resulting version. */
  putRow(scope: string, row: D1Row, prevVersion: number | null): Promise<number>
  /**
   * Versioned compare-and-set. Writes `row` only if the current version equals
   * `expectedVersion` (when given) and the row exists+is live. Returns the new
   * version on success, `-1` on miss, `-2` on a version conflict.
   */
  updateCas(scope: string, row: D1Row, expectedVersion: number | undefined): Promise<number>
  /**
   * Versioned delete. Hard-removes (or, when `softDeletePayload` is given,
   * tombstones) the row at `(scope, id)`. Returns the new version on a
   * soft-delete, `0` on a successful hard delete, `-1` on miss, `-2` on conflict.
   */
  deleteCas(
    scope: string,
    id: string,
    expectedVersion: number | undefined,
    softDeletePayload: D1Row | null,
  ): Promise<number>
  /** List rows in a scope, ordered by `id`, honoring filter + cursor. */
  listRows(scope: string, args: D1ListArgs): Promise<D1Row[]>
  /** Count rows in a scope honoring the filter (server-side `COUNT(*)`). */
  count(scope: string, filter: Record<string, string | number | boolean> | undefined, excludeDeleted: boolean): Promise<number>
}

/** Reply sentinels from {@link D1DataPort.updateCas} / {@link D1DataPort.deleteCas}. */
const MISS = -1
const CONFLICT = -2

/**
 * Cap on total KV keys a single `KvDataStore.list` may GET, as a multiple of the
 * requested page limit. Each dropped key (tombstone / corrupt / filter-miss) is a
 * subrequest that does not fill the page; without a cap a tombstone-heavy scope
 * could exceed the Workers subrequest budget. When hit, list() returns early with
 * the KV cursor as a valid resume point.
 */
const KV_LIST_SCAN_MULTIPLE = 10

// ---------------------------------------------------------------------------
// D1DatabaseLike — the structural slice of a Cloudflare `D1Database` we use.
// ---------------------------------------------------------------------------

/** A prepared statement, structurally satisfied by D1's `D1PreparedStatement`. */
export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
  run(): Promise<{ meta: { changes?: number; rows_written?: number } }>
}

/**
 * The slice of a Cloudflare `D1Database` {@link createD1DataPort} maps onto. A
 * consumer's real `env.DB` binding is a structural superset — so nothing here
 * imports `@cloudflare/workers-types` (ARCH-01). Only `prepare` is used; the
 * fluent `bind`/`first`/`all`/`run` come off the prepared statement.
 */
export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike
}

// ---------------------------------------------------------------------------
// D1DataStore.
// ---------------------------------------------------------------------------

/** Default D1 table name; override via {@link D1DataStoreOptions.table}. */
export const D1_TABLE_DEFAULT = 'data_store'

/** Options for {@link createD1DataStore} / {@link D1DataStore}. */
export interface D1DataStoreOptions {
  /**
   * The D1 table backing this collection. Default {@link D1_TABLE_DEFAULT}. Used
   * by {@link createD1DataPort} when building SQL; the consumer must have created
   * the table (see {@link d1CreateTableSql}).
   */
  table?: string
  /**
   * Tombstone on delete instead of hard-removing, and hide tombstoned rows from
   * `get`/`list`/`count` (default `false`). Mirrors `@persisted(softDelete:)`.
   */
  softDelete?: boolean
  /**
   * Declared `@persisted` index field names. With D1, an equality filter on ANY
   * field is a server-side `WHERE` (no client scan), but declaring an index lets
   * the consumer add a matching SQL index (see {@link d1CreateIndexSql}) so the
   * filter stays sargable at scale. Kept for parity with the other adapters.
   */
  indexes?: readonly string[]
}

class D1DataStore<T extends Record<string, unknown>> implements DataStore<T> {
  readonly #port: D1DataPort
  readonly #softDelete: boolean
  readonly #indexes: ReadonlySet<string>

  constructor(port: D1DataPort, opts: D1DataStoreOptions = {}) {
    this.#port = port
    this.#softDelete = opts.softDelete ?? false
    this.#indexes = new Set(opts.indexes ?? [])
  }

  /** Filter fields NOT backed by a declared `@persisted` index (no matching SQL index). */
  #undeclaredFields(
    filter: Record<string, string | number | boolean> | undefined,
  ): string[] {
    if (!filter) return []
    return Object.keys(filter).filter((f) => !this.#indexes.has(f))
  }

  async get(key: string, scope: DataScope): Promise<Stored<T> | null> {
    const row = await this.#port.getRow(scopeSeg(scope), key)
    if (row === null) return null
    if (row.deletedAt !== null) return null // tombstone invisible
    return this.#decode(row)
  }

  async create(key: string, value: T, scope: DataScope): Promise<Stored<T>> {
    // A fresh insert is version 1; resurrecting a soft-delete tombstone CONTINUES
    // from the tombstone's version (never reset to 1), so the port reports back the
    // resulting version rather than us assuming 1.
    const version = await this.#port.insertIfAbsent(
      scopeSeg(scope),
      { id: key, value: JSON.stringify(this.#strip(value)), version: 1, deletedAt: null },
      this.#softDelete,
    )
    if (version === 0) {
      throw new Error(`Entity already exists at key '${key}'`)
    }
    return { ...value, version } as Stored<T>
  }

  async put(key: string, value: T, scope: DataScope): Promise<Stored<T>> {
    const existing = await this.#port.getRow(scopeSeg(scope), key)
    const newVersion = await this.#port.putRow(
      scopeSeg(scope),
      { id: key, value: JSON.stringify(this.#strip(value)), version: 0, deletedAt: null },
      existing?.version ?? null,
    )
    return { ...value, version: newVersion } as Stored<T>
  }

  async update(
    key: string,
    value: T,
    expectedVersion: number | undefined,
    scope: DataScope,
  ): Promise<Stored<T>> {
    const reply = await this.#port.updateCas(
      scopeSeg(scope),
      { id: key, value: JSON.stringify(this.#strip(value)), version: 0, deletedAt: null },
      expectedVersion,
    )
    this.#assertWritten(reply, key)
    return { ...value, version: reply } as Stored<T>
  }

  async patch(
    key: string,
    partial: Partial<T>,
    expectedVersion: number | undefined,
    scope: DataScope,
  ): Promise<Stored<T>> {
    const existing = await this.#port.getRow(scopeSeg(scope), key)
    if (!existing || existing.deletedAt !== null) {
      throw new Error(`Entity not found at key '${key}'`)
    }
    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw new OptimisticConflictError(
        `Version mismatch: expected ${expectedVersion}, found ${existing.version}`,
      )
    }
    const current = JSON.parse(existing.value) as T
    const merged = { ...current, ...partial } as unknown as T
    const reply = await this.#port.updateCas(
      scopeSeg(scope),
      { id: key, value: JSON.stringify(this.#strip(merged)), version: 0, deletedAt: null },
      // Guard on the version we just read so a racing writer still trips CONFLICT.
      existing.version,
    )
    this.#assertWritten(reply, key)
    return { ...merged, version: reply } as Stored<T>
  }

  async delete(
    key: string,
    expectedVersion: number | undefined,
    scope: DataScope,
  ): Promise<boolean> {
    let payload: D1Row | null = null
    if (this.#softDelete) {
      const existing = await this.#port.getRow(scopeSeg(scope), key)
      if (!existing || existing.deletedAt !== null) return false
      if (expectedVersion !== undefined && existing.version !== expectedVersion) {
        throw new OptimisticConflictError(
          `Version mismatch: expected ${expectedVersion}, stale delete on key '${key}'`,
        )
      }
      payload = {
        id: key,
        value: existing.value,
        version: existing.version + 1,
        deletedAt: new Date().toISOString(),
      }
    }
    const reply = await this.#port.deleteCas(scopeSeg(scope), key, expectedVersion, payload)
    if (reply === MISS) return false
    if (reply === CONFLICT) {
      throw new OptimisticConflictError(
        `Version mismatch: expected ${expectedVersion}, stale delete on key '${key}'`,
      )
    }
    return true
  }

  async list(query: ListQuery, scope: DataScope): Promise<Page<T>> {
    if (query.limit < 1) throw new RangeError('list limit must be >= 1')
    const undeclared = this.#undeclaredFields(query.filter)
    if (undeclared.length > 0) {
      // D1 has no statement_timeout, so an undeclared filter forces a full
      // server-side scope scan with no time bound (the matching SQL index is
      // absent). Warn so operators see the unindexed scan; the LIMIT still caps
      // rows RETURNED. Mirrors adapter-node / adapter-aws.
      console.warn(
        `[adapter-cf] DataStore.list: filtering on non-declared index ` +
          `${undeclared.join(',')} via a full server-side scope scan ` +
          `(no index); declare it in @persisted(indexes) for a sargable filter.`,
      )
    }
    const after = query.cursor ? decodeCursor(query.cursor) : undefined
    // Ask for one extra row to know whether a further page exists.
    const rows = await this.#port.listRows(scopeSeg(scope), {
      limit: query.limit + 1,
      after,
      filter: query.filter,
      excludeDeleted: this.#softDelete,
    })
    const page = rows.slice(0, query.limit)
    const items = page.map((r) => this.#decode(r))
    const hasMore = rows.length > query.limit
    const cursor =
      hasMore && page.length > 0 ? encodeCursor(page[page.length - 1].id) : undefined
    return cursor ? { items, cursor } : { items }
  }

  async count(
    query: Omit<ListQuery, 'cursor' | 'limit'>,
    scope: DataScope,
  ): Promise<number> {
    // `count` must be EXACT, and D1 has no statement_timeout to bound an
    // unindexed full-scope COUNT(*) — so a count on a non-declared index is the
    // worst case (an uncapped scan that can't be row-capped without lying).
    // Refuse it, mirroring adapter-aws; declare the field in @persisted(indexes)
    // for a sargable server-side count.
    const undeclared = this.#undeclaredFields(query.filter)
    if (undeclared.length > 0) {
      throw new Error(
        `[adapter-cf] DataStore.count: an exact count on a non-declared index ` +
          `(${undeclared.join(',')}) would require an uncapped full-scope scan; ` +
          `declare it in @persisted(indexes) for a server-side count.`,
      )
    }
    return this.#port.count(scopeSeg(scope), query.filter, this.#softDelete)
  }

  // --- internals ----------------------------------------------------------

  /** Reconstruct a {@link Stored} envelope from a row's JSON + version. */
  #decode(row: D1Row): Stored<T> {
    const obj = JSON.parse(row.value) as Record<string, unknown>
    return { ...obj, version: row.version } as Stored<T>
  }

  /** Drop the store-managed `version` from the persisted JSON (it lives in its column). */
  #strip(stored: Stored<T> | T): Record<string, unknown> {
    const { version: _v, ...rest } = stored as Record<string, unknown>
    return rest
  }

  #assertWritten(reply: number, key: string): void {
    if (reply === MISS) throw new Error(`Entity not found at key '${key}'`)
    if (reply === CONFLICT) {
      throw new OptimisticConflictError(`Version mismatch on key '${key}'`)
    }
  }
}

// ---------------------------------------------------------------------------
// D1 schema helpers (the consumer runs these as a migration).
// ---------------------------------------------------------------------------

/**
 * The `CREATE TABLE` for a D1-backed {@link DataStore}. The consumer runs this
 * once (a wrangler migration / `d1 execute`) per collection — the adapter never
 * issues DDL at runtime (a Worker shouldn't migrate on the hot path).
 *
 *   - `(scope, id)` is the composite PRIMARY KEY → cross-scope get returns
 *     nothing, same key in two scopes never collides.
 *   - `value` holds the entity JSON; declared indexes are computed expressions
 *     over it (see {@link d1CreateIndexSql}).
 *   - `deleted_at` is NULL for live rows; a tombstone ISO string when soft-deleted.
 *
 * @param table the table name (default {@link D1_TABLE_DEFAULT}); must match
 *   the `opts.table` passed to {@link createD1DataStore} / {@link createD1DataPort}.
 */
export function d1CreateTableSql(table: string = D1_TABLE_DEFAULT): string {
  return (
    `CREATE TABLE IF NOT EXISTS "${table}" (\n` +
    `  scope TEXT NOT NULL,\n` +
    `  id TEXT NOT NULL,\n` +
    `  value TEXT NOT NULL,\n` +
    `  version INTEGER NOT NULL,\n` +
    `  deleted_at TEXT,\n` +
    `  PRIMARY KEY (scope, id)\n` +
    `);`
  )
}

/**
 * A computed-column index for one declared `@persisted` index field, so an
 * equality `filter` on it stays sargable in SQL. Mirrors the adapter-node
 * declared-index SETs. The consumer runs this alongside {@link d1CreateTableSql}.
 *
 * @example d1CreateIndexSql('data_store', 'ownerId')
 */
export function d1CreateIndexSql(table: string, field: string): string {
  // DDL identifiers / JSON paths can't be bound parameters, so the field is
  // interpolated — validate it against a strict allowlist (mirrors the index-NAME
  // sanitizer) and throw rather than silently mangling, so an attacker-controlled
  // field can never break out of the CREATE INDEX statement.
  if (!/^[A-Za-z0-9_]+$/.test(field)) {
    throw new Error(
      `d1CreateIndexSql: invalid index field '${field}' ` +
        `(must match /^[A-Za-z0-9_]+$/)`,
    )
  }
  return (
    `CREATE INDEX IF NOT EXISTS "${table}_idx_${field}" ON "${table}" ` +
    `(scope, json_extract(value, '$.${field}'));`
  )
}

// ---------------------------------------------------------------------------
// Real D1 port — the ONLY place that speaks SQL (ARCH-01: structural binding).
// ---------------------------------------------------------------------------

/**
 * Build a `json_extract(value, ?) = ?` predicate list from a filter. Both the
 * JSON PATH and the VALUE are bound parameters — never interpolated — so a
 * caller-controlled filter key cannot break out of the SQL (no injection, no
 * `D1_ERROR: syntax error` DoS). SQLite accepts the path as a bound parameter.
 */
function filterPredicates(
  filter: Record<string, string | number | boolean> | undefined,
): { sql: string; binds: (string | number)[] } {
  if (!filter) return { sql: '', binds: [] }
  const clauses: string[] = []
  const binds: (string | number)[] = []
  for (const [field, value] of Object.entries(filter)) {
    clauses.push(`json_extract(value, ?) = ?`)
    binds.push(`$.${field}`)
    binds.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
  }
  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', binds }
}

/**
 * Build the REAL {@link D1DataPort} over a structural {@link D1DatabaseLike}.
 * This is the only SQL in the adapter; the store logic stays SQL-free.
 *
 * Versioned writes are a single conditional `UPDATE ... WHERE scope=? AND id=?
 * AND version=?` — D1 runs each statement atomically, so `meta.changes === 0`
 * unambiguously means "no row matched the version" → {@link CONFLICT}. Create is
 * `INSERT ... ON CONFLICT DO NOTHING` (0 changes ⇒ already exists).
 *
 * Production wiring: `createD1DataPort(env.DB)`.
 *
 * @param db the consumer's `D1Database` binding (structural).
 * @param table the table name; must match {@link createD1DataStore}'s `opts.table`.
 */
export function createD1DataPort(
  db: D1DatabaseLike,
  table: string = D1_TABLE_DEFAULT,
): D1DataPort {
  const t = `"${table.replace(/"/g, '')}"`

  const toRow = (r: Record<string, unknown> | null): D1Row | null => {
    if (!r) return null
    return {
      id: String(r.id),
      value: String(r.value),
      version: Number(r.version),
      deletedAt: r.deleted_at === null || r.deleted_at === undefined ? null : String(r.deleted_at),
    }
  }

  return {
    async getRow(scope, id) {
      const r = await db
        .prepare(`SELECT id, value, version, deleted_at FROM ${t} WHERE scope = ? AND id = ?`)
        .bind(scope, id)
        .first()
      return toRow(r)
    },

    async insertIfAbsent(scope, row, allowOverTombstone) {
      // INSERT-if-absent. When soft-delete create-over-tombstone is allowed, the
      // ON CONFLICT path resurrects a tombstoned row (deleted_at IS NOT NULL) but
      // still refuses to overwrite a LIVE row (the WHERE keeps create exclusive).
      // The resurrected version CONTINUES from the tombstone (version + 1) — it is
      // never reset to 1 (contract: create/put over a soft-delete tombstone bumps,
      // only a first create / create after a HARD delete starts at 1).
      const onConflict = allowOverTombstone
        ? ` ON CONFLICT(scope, id) DO UPDATE SET value = excluded.value, ` +
          `version = ${t}.version + 1, deleted_at = NULL WHERE ${t}.deleted_at IS NOT NULL`
        : ` ON CONFLICT(scope, id) DO NOTHING`
      // RETURNING gives us the resulting version (1 on a fresh insert, the
      // continued tombstone.version + 1 on resurrection). A blocked write (LIVE row
      // already present) changes nothing → no row returned → report 0 ("exists").
      const r = await db
        .prepare(
          `INSERT INTO ${t} (scope, id, value, version, deleted_at) VALUES (?, ?, ?, ?, NULL)` +
            onConflict +
            ` RETURNING version`,
        )
        .bind(scope, row.id, row.value, row.version)
        .first<{ version: number }>()
      return r ? Number(r.version) : 0
    },

    async putRow(scope, row, prevVersion) {
      const newVersion = prevVersion === null ? 1 : prevVersion + 1
      await db
        .prepare(
          `INSERT INTO ${t} (scope, id, value, version, deleted_at) VALUES (?, ?, ?, ?, NULL) ` +
            `ON CONFLICT(scope, id) DO UPDATE SET value = excluded.value, ` +
            `version = excluded.version, deleted_at = NULL`,
        )
        .bind(scope, row.id, row.value, newVersion)
        .run()
      return newVersion
    },

    async updateCas(scope, row, expectedVersion) {
      // Read the live row to disambiguate miss vs conflict (D1 changes count
      // alone can't tell them apart). The conditional UPDATE then enforces the
      // CAS atomically — a racing writer still flips changes to 0.
      const cur = toRow(
        await db
          .prepare(`SELECT id, value, version, deleted_at FROM ${t} WHERE scope = ? AND id = ?`)
          .bind(scope, row.id)
          .first(),
      )
      if (!cur || cur.deletedAt !== null) return MISS
      const guard = expectedVersion === undefined ? cur.version : expectedVersion
      const res = await db
        .prepare(
          `UPDATE ${t} SET value = ?, version = version + 1 ` +
            `WHERE scope = ? AND id = ? AND version = ? AND deleted_at IS NULL`,
        )
        .bind(row.value, scope, row.id, guard)
        .run()
      if ((res.meta.changes ?? 0) === 0) return CONFLICT
      return guard + 1
    },

    async deleteCas(scope, id, expectedVersion, softDeletePayload) {
      const cur = toRow(
        await db
          .prepare(`SELECT id, value, version, deleted_at FROM ${t} WHERE scope = ? AND id = ?`)
          .bind(scope, id)
          .first(),
      )
      if (!cur || cur.deletedAt !== null) return MISS
      if (expectedVersion !== undefined && cur.version !== expectedVersion) return CONFLICT
      const guard = cur.version
      if (softDeletePayload) {
        const res = await db
          .prepare(
            `UPDATE ${t} SET deleted_at = ?, version = version + 1 ` +
              `WHERE scope = ? AND id = ? AND version = ? AND deleted_at IS NULL`,
          )
          .bind(softDeletePayload.deletedAt, scope, id, guard)
          .run()
        if ((res.meta.changes ?? 0) === 0) return CONFLICT
        return guard + 1
      }
      const res = await db
        .prepare(`DELETE FROM ${t} WHERE scope = ? AND id = ? AND version = ?`)
        .bind(scope, id, guard)
        .run()
      if ((res.meta.changes ?? 0) === 0) return CONFLICT
      return 0
    },

    async listRows(scope, args) {
      const { sql: filterSql, binds: filterBinds } = filterPredicates(args.filter)
      const afterSql = args.after !== undefined ? ` AND id > ?` : ''
      const deletedSql = args.excludeDeleted ? ` AND deleted_at IS NULL` : ''
      const binds: (string | number)[] = [scope, ...filterBinds]
      if (args.after !== undefined) binds.push(args.after)
      binds.push(args.limit)
      const { results } = await db
        .prepare(
          `SELECT id, value, version, deleted_at FROM ${t} ` +
            `WHERE scope = ?${filterSql}${deletedSql}${afterSql} ORDER BY id ASC LIMIT ?`,
        )
        .bind(...binds)
        .all()
      return results.map((r) => toRow(r)!).filter((r): r is D1Row => r !== null)
    },

    async count(scope, filter, excludeDeleted) {
      const { sql: filterSql, binds: filterBinds } = filterPredicates(filter)
      const deletedSql = excludeDeleted ? ` AND deleted_at IS NULL` : ''
      const r = await db
        .prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE scope = ?${filterSql}${deletedSql}`)
        .bind(scope, ...filterBinds)
        .first<{ n: number }>()
      return r ? Number(r.n) : 0
    },
  }
}

// ---------------------------------------------------------------------------
// Fake D1 port — in-process Map, reimplements the semantics (no SQL parser).
// ---------------------------------------------------------------------------

/**
 * An in-process {@link D1DataPort} backed by a `Map`. Reimplements the CAS /
 * create-if-absent / filtered-list semantics in JS — exactly as adapter-node's
 * `createFakeRedisDataPort` reimplements the Lua CAS — so the always-on
 * conformance suite exercises all store logic with no D1/miniflare. The real SQL
 * is validated by `live.miniflare.dataStore.test.ts` in CI.
 *
 * Each call runs its read-compare-write in one synchronous section before the
 * returned promise settles, so there is no interleaving (JS single-thread), the
 * same atomicity D1 gives per statement.
 */
export function createFakeD1DataPort(): D1DataPort {
  /** `${scope} ${id}` → row. */
  const rows = new Map<string, D1Row>()
  const k = (scope: string, id: string): string => `${scope} ${id}`

  const liveMatches = (
    row: D1Row,
    scope: string,
    filter: Record<string, string | number | boolean> | undefined,
    excludeDeleted: boolean,
    afterId: string | undefined,
    scopeKey: string,
  ): boolean => {
    if (!scopeKey.startsWith(`${scope} `)) return false
    if (excludeDeleted && row.deletedAt !== null) return false
    if (afterId !== undefined && !(row.id > afterId)) return false
    if (filter) {
      const obj = JSON.parse(row.value) as Record<string, unknown>
      for (const [field, want] of Object.entries(filter)) {
        if (obj[field] !== want) return false
      }
    }
    return true
  }

  return {
    async getRow(scope, id) {
      return rows.get(k(scope, id)) ?? null
    },

    async insertIfAbsent(scope, row, allowOverTombstone) {
      const cur = rows.get(k(scope, row.id))
      const overTombstone = allowOverTombstone && cur !== undefined && cur.deletedAt !== null
      if (cur && !overTombstone) return 0
      // Fresh insert → version 1; resurrecting a tombstone → CONTINUE (tombstone
      // version + 1), never reset to 1.
      const version = overTombstone ? cur!.version + 1 : 1
      rows.set(k(scope, row.id), { ...row, version, deletedAt: null })
      return version
    },

    async putRow(scope, row, prevVersion) {
      const newVersion = prevVersion === null ? 1 : prevVersion + 1
      rows.set(k(scope, row.id), { ...row, version: newVersion, deletedAt: null })
      return newVersion
    },

    async updateCas(scope, row, expectedVersion) {
      const cur = rows.get(k(scope, row.id))
      if (!cur || cur.deletedAt !== null) return MISS
      if (expectedVersion !== undefined && cur.version !== expectedVersion) return CONFLICT
      const newVersion = cur.version + 1
      rows.set(k(scope, row.id), { ...row, version: newVersion, deletedAt: null })
      return newVersion
    },

    async deleteCas(scope, id, expectedVersion, softDeletePayload) {
      const cur = rows.get(k(scope, id))
      if (!cur || cur.deletedAt !== null) return MISS
      if (expectedVersion !== undefined && cur.version !== expectedVersion) return CONFLICT
      if (softDeletePayload) {
        const newVersion = cur.version + 1
        rows.set(k(scope, id), { ...softDeletePayload, version: newVersion })
        return newVersion
      }
      rows.delete(k(scope, id))
      return 0
    },

    async listRows(scope, args) {
      const out: D1Row[] = []
      for (const [key, row] of rows) {
        if (liveMatches(row, scope, args.filter, args.excludeDeleted, args.after, key)) {
          out.push(row)
        }
      }
      out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      return out.slice(0, args.limit)
    },

    async count(scope, filter, excludeDeleted) {
      let n = 0
      for (const [key, row] of rows) {
        if (liveMatches(row, scope, filter, excludeDeleted, undefined, key)) n++
      }
      return n
    },
  }
}

// ---------------------------------------------------------------------------
// D1 factory.
// ---------------------------------------------------------------------------

/**
 * Construct a D1-backed {@link DataStore} over a {@link D1DataPort}. Like the
 * security stores, the logic lives only against the port, so the same class
 * passes the `@smithy-hono/data-core` conformance suite against the in-process
 * fake AND runs unchanged against real D1 in production.
 *
 * Full capabilities: optimistic concurrency (SQL CAS), equality filter + count
 * (`WHERE`), opaque-cursor pagination, and (opt-in) soft-delete.
 *
 * @example
 *   const store = createD1DataStore(
 *     createD1DataPort(env.DB, 'todos'),
 *     { table: 'todos', indexes: ['ownerId'], softDelete: false },
 *   )
 */
export function createD1DataStore<
  T extends Record<string, unknown> = Record<string, unknown>,
>(port: D1DataPort, opts: D1DataStoreOptions = {}): DataStore<T> {
  return new D1DataStore<T>(port, opts)
}

export { D1DataStore }

// ===========================================================================
// PART 2 — KV DataStore: key-access SUBSET, fail-fast (no safe versioned write).
// ===========================================================================

/**
 * Options for {@link createKvDataStore} / {@link KvDataStore}.
 *
 * KV is eventually consistent and has NO atomic compare-and-set, so it CANNOT
 * safely honor `expectedVersion` — the same reason rate-limit/nonce "MUST NOT
 * use KV" (`ports.ts:26-30`). `optimisticConcurrency: true` therefore THROWS at
 * construction (fail fast) rather than silently doing last-write-wins.
 */
export interface KvDataStoreOptions {
  /** Key prefix namespacing this collection within a KV namespace. Default `'ds:'`. */
  prefix?: string
  /**
   * Tombstone on delete instead of hard-removing (default `false`). Even soft
   * delete is best-effort under KV's eventual consistency.
   */
  softDelete?: boolean
  /**
   * MUST be omitted or `false`. KV cannot do a safe versioned write, so passing
   * `true` THROWS at construction (fail fast), mirroring the "RATE/nonce MUST NOT
   * use KV" rule. `update`/`patch` are last-write-wins (version bumped, NOT guarded).
   */
  optimisticConcurrency?: boolean
  /**
   * OPTIONAL upper bound on a `list`'s effective page size (defense-in-depth). When
   * set, `list` silently CLAMPS `query.limit` down to `maxLimit`
   * (`Math.min(query.limit, maxLimit)`) so a large caller `limit` cannot drive an
   * unbounded scan — it does NOT reject the request. Unset (default) means NO clamp:
   * behavior is identical to before this knob existed. The clamp also scales the
   * per-key GET scan budget (`limit * KV_LIST_SCAN_MULTIPLE`) off the clamped value;
   * the opaque resume-cursor contract is unchanged.
   */
  maxLimit?: number
}

/**
 * The slice of a Workers `KVNamespace` the KV DataStore needs for prefix-scoped
 * pagination, on top of {@link KvNamespaceLike}'s get/put/delete. A consumer's
 * real binding is a structural superset.
 */
export interface KvListNamespaceLike extends KvNamespaceLike {
  /**
   * `KVNamespace.list` — keys under a prefix with native opaque-cursor
   * pagination. `list_complete` is false when more keys remain.
   */
  list(opts?: {
    prefix?: string
    limit?: number
    cursor?: string
  }): Promise<{
    keys: { name: string }[]
    list_complete: boolean
    cursor?: string
  }>
}

/**
 * KV is keyed flat under one namespace and has no native versioned write, so the
 * value carries its own `version`/`deletedAt` envelope. `update`/`patch` do a
 * read-then-unconditional-put: the version is bumped for client visibility but is
 * NOT a concurrency guard (last-write-wins — two racing writers can clobber).
 * That is the documented, accepted limitation; callers needing safe versioned
 * writes use the D1 store. The conformance descriptor declares
 * `{ optimisticConcurrency: false, filter: false }` accordingly.
 */
interface KvEnvelope {
  /** The entity JSON (the store-managed `version` lives alongside, not inside). */
  value: Record<string, unknown>
  version: number
  deletedAt?: string
}

/**
 * Parse a stored KV value into a {@link KvEnvelope}, returning `null` for a
 * corrupt or wrong-shaped row instead of throwing. KV is writable out-of-band,
 * so a malformed value (invalid JSON, or valid JSON missing `version`/`value`)
 * MUST NOT fault a read: a single poisoned key would otherwise throw a raw
 * `SyntaxError` out of an entire `list()` page or a `get()`. Callers treat
 * `null` as ABSENT (skip in `list`, return null in `#load`) — defense-in-depth
 * over operator-controlled infrastructure (SECRETS-DATA-SQL-05).
 */
function parseKvEnvelope(raw: string): KvEnvelope | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { version?: unknown }).version !== 'number' ||
    typeof (parsed as { value?: unknown }).value !== 'object' ||
    (parsed as { value?: unknown }).value === null
  ) {
    return null
  }
  return parsed as KvEnvelope
}

class KvDataStore<T extends Record<string, unknown>> implements DataStore<T> {
  readonly #kv: KvListNamespaceLike
  readonly #prefix: string
  readonly #softDelete: boolean
  readonly #maxLimit: number | undefined

  constructor(kv: KvListNamespaceLike, opts: KvDataStoreOptions = {}) {
    if (opts.optimisticConcurrency) {
      // Fail fast — KV has no atomic CAS, so a "version-guarded" write would be a
      // lie (last-write-wins). Mirrors the RATE/nonce "MUST NOT use KV" rule.
      throw new Error(
        'createKvDataStore: optimisticConcurrency is not supported on Workers KV ' +
          '(eventually consistent, no atomic compare-and-set). Use createD1DataStore ' +
          'for version-guarded writes, or omit optimisticConcurrency for last-write-wins.',
      )
    }
    this.#kv = kv
    this.#prefix = opts.prefix ?? 'ds:'
    this.#softDelete = opts.softDelete ?? false
    this.#maxLimit = opts.maxLimit
  }

  /** Entity key: `<prefix><scope>|<id>`; scope length-prefixed (cross-scope isolation). */
  #key(scope: DataScope, id: string): string {
    return `${this.#prefix}${scopeSeg(scope)}|${id}`
  }

  /** The `list()` prefix that enumerates exactly one scope. */
  #scopePrefix(scope: DataScope): string {
    return `${this.#prefix}${scopeSeg(scope)}|`
  }

  async get(key: string, scope: DataScope): Promise<Stored<T> | null> {
    const env = await this.#load(scope, key)
    if (!env || env.deletedAt !== undefined) return null
    return this.#decode(env)
  }

  async create(key: string, value: T, scope: DataScope): Promise<Stored<T>> {
    // Best-effort create: KV has no atomic put-if-absent, so this read-then-put
    // is racy under concurrent creates (accepted — see the class doc).
    const existing = await this.#load(scope, key)
    if (existing && existing.deletedAt === undefined) {
      throw new Error(`Entity already exists at key '${key}'`)
    }
    // Fresh create → version 1. Create OVER a soft-delete tombstone resurrects and
    // CONTINUES the version (tombstone.version + 1), never reset to 1.
    const version = existing ? existing.version + 1 : 1
    const env: KvEnvelope = { value: this.#strip(value), version }
    await this.#kv.put(this.#key(scope, key), JSON.stringify(env))
    return { ...value, version } as Stored<T>
  }

  async put(key: string, value: T, scope: DataScope): Promise<Stored<T>> {
    const existing = await this.#load(scope, key)
    // Continue the version whenever a row exists — live OR a soft-delete tombstone
    // (put over a tombstone resurrects and CONTINUES, never resets to 1).
    const version = existing ? existing.version + 1 : 1
    const env: KvEnvelope = { value: this.#strip(value), version }
    await this.#kv.put(this.#key(scope, key), JSON.stringify(env))
    return { ...value, version } as Stored<T>
  }

  async update(
    key: string,
    value: T,
    _expectedVersion: number | undefined,
    scope: DataScope,
  ): Promise<Stored<T>> {
    // Last-write-wins: expectedVersion is intentionally ignored (KV can't guard
    // it). The version is still bumped for client visibility.
    const existing = await this.#load(scope, key)
    if (!existing || existing.deletedAt !== undefined) {
      throw new Error(`Entity not found at key '${key}'`)
    }
    const version = existing.version + 1
    const env: KvEnvelope = { value: this.#strip(value), version }
    await this.#kv.put(this.#key(scope, key), JSON.stringify(env))
    return { ...value, version } as Stored<T>
  }

  async patch(
    key: string,
    partial: Partial<T>,
    _expectedVersion: number | undefined,
    scope: DataScope,
  ): Promise<Stored<T>> {
    const existing = await this.#load(scope, key)
    if (!existing || existing.deletedAt !== undefined) {
      throw new Error(`Entity not found at key '${key}'`)
    }
    const merged = { ...existing.value, ...partial } as unknown as T
    const version = existing.version + 1
    const env: KvEnvelope = { value: this.#strip(merged), version }
    await this.#kv.put(this.#key(scope, key), JSON.stringify(env))
    return { ...merged, version } as Stored<T>
  }

  async delete(
    key: string,
    _expectedVersion: number | undefined,
    scope: DataScope,
  ): Promise<boolean> {
    const existing = await this.#load(scope, key)
    if (!existing || existing.deletedAt !== undefined) return false
    if (this.#softDelete) {
      const env: KvEnvelope = {
        value: existing.value,
        version: existing.version + 1,
        deletedAt: new Date().toISOString(),
      }
      await this.#kv.put(this.#key(scope, key), JSON.stringify(env))
    } else {
      await this.#kv.delete(this.#key(scope, key))
    }
    return true
  }

  async list(query: ListQuery, scope: DataScope): Promise<Page<T>> {
    // KV native prefix list → real opaque cursor. KV cannot equality-filter
    // opaque values, so `filter` is unsupported (declared false in conformance).
    //
    // A raw KV page may be entirely tombstones / filter-misses that we drop AFTER
    // fetching. Naively taking list_complete/cursor from a single raw page would
    // emit {items:[], cursor:<set>} for an all-dropped page — a client that stops
    // on the first empty page would then miss live rows after it (and the new
    // pagination-anchor-deletion conformance test fails under soft-delete).
    //
    // So we loop kv.list, threading KV's own opaque cursor, until we have `limit`
    // MATCHING items or KV reports list_complete. Each raw request asks for only
    // `limit - matched` keys (the remaining need), so a raw page yields at most
    // that many matches — we never overshoot `limit`, and we always consume a raw
    // page IN FULL, which keeps `res.cursor` a valid resume point (it never skips
    // keys we didn't process). The store cursor is KV's cursor and is emitted
    // only while KV is not yet complete (more matching rows may remain).
    if (query.limit < 1) throw new RangeError('list limit must be >= 1')
    // Optional defense-in-depth clamp: lower the effective page size to maxLimit
    // when configured. Unset = no clamp = identical to the prior behavior. The
    // scan budget below scales off this clamped value too.
    const effectiveLimit =
      this.#maxLimit !== undefined ? Math.min(query.limit, this.#maxLimit) : query.limit
    const prefix = this.#scopePrefix(scope)
    const items: Stored<T>[] = []
    let kvCursor = query.cursor
    let listComplete = false
    // Bound the total per-key GETs a single list() may issue. Each dropped key
    // (tombstone / corrupt / filter-miss) costs one kv.get subrequest without
    // filling the page, so a scope with many such keys ahead of the next live row
    // could otherwise blow the Workers subrequest budget (50 free / 1000 paid) and
    // fault the whole call. When the budget is hit we stop and return the KV cursor
    // as a valid resume point (each raw page is consumed IN FULL), so the caller
    // can continue — DataStore.list's resume-cursor contract is preserved.
    const maxScan = effectiveLimit * KV_LIST_SCAN_MULTIPLE
    let scanned = 0
    while (items.length < effectiveLimit) {
      const res = await this.#kv.list({
        prefix,
        limit: effectiveLimit - items.length,
        cursor: kvCursor,
      })
      for (const { name } of res.keys) {
        scanned++
        const raw = await this.#kv.get(name)
        if (raw === null) continue
        const env = parseKvEnvelope(raw)
        // A corrupt / wrong-shaped row is treated as ABSENT — skip it so one
        // poisoned KV key cannot fault the whole list page (SECRETS-DATA-SQL-05).
        if (env === null) continue
        if (env.deletedAt !== undefined) continue // tombstone invisible
        const stored = this.#decode(env)
        if (!matchesFilter(stored, query.filter)) continue
        items.push(stored)
        if (items.length >= effectiveLimit) break
      }
      kvCursor = res.cursor
      // KV always returns a cursor while not complete; guard against an absent
      // one (would otherwise restart from the prefix start → infinite loop).
      if (res.list_complete || kvCursor === undefined) {
        listComplete = true
        break
      }
      // Stop once the scan budget is spent; the KV cursor resumes from here.
      if (scanned >= maxScan) break
    }
    // Emit a resume cursor whenever KV is not drained — either more matching rows
    // remain (page filled) or the scan budget stopped us short.
    return listComplete ? { items } : { items, cursor: kvCursor }
  }

  // --- internals ----------------------------------------------------------

  async #load(scope: DataScope, key: string): Promise<KvEnvelope | null> {
    const raw = await this.#kv.get(this.#key(scope, key))
    // A corrupt / wrong-shaped row is treated as ABSENT (null) rather than
    // throwing a raw SyntaxError out of get/update/delete (SECRETS-DATA-SQL-05).
    return raw === null ? null : parseKvEnvelope(raw)
  }

  #decode(env: KvEnvelope): Stored<T> {
    return { ...env.value, version: env.version } as Stored<T>
  }

  #strip(value: Stored<T> | T): Record<string, unknown> {
    const { version: _v, ...rest } = value as Record<string, unknown>
    return rest
  }
}

/**
 * Construct a Workers-KV-backed {@link DataStore} — the key-access SUBSET.
 *
 * FAIL FAST: passing `optimisticConcurrency: true` THROWS (KV has no atomic CAS).
 * Capabilities for conformance: `{ optimisticConcurrency: false, filter: false }`
 * (KV can't safely guard versions nor equality-filter opaque values); pagination
 * (native prefix `list()` cursor) and soft-delete ARE supported. `update`/`patch`
 * are last-write-wins (version bumped for visibility, not guarded). For
 * version-guarded writes use {@link createD1DataStore}.
 *
 * @example
 *   const store = createKvDataStore(env.MY_KV, { prefix: 'todos:' })
 */
export function createKvDataStore<
  T extends Record<string, unknown> = Record<string, unknown>,
>(kv: KvListNamespaceLike, opts: KvDataStoreOptions = {}): DataStore<T> {
  return new KvDataStore<T>(kv, opts)
}

export { KvDataStore }
