/**
 * `DataStore<T>` (Plan 13 D7 — Postgres is the durable Node default) over
 * Postgres, behind a narrow structural client port (ARCH-01).
 *
 * Postgres is a *database* backend, not a runtime, so this is its own package —
 * usable from any runtime with a structural client (`pg`, `postgres.js`, Neon
 * serverless). It is the **recommended durable store of record for the Node
 * deployment**; the Redis `DataStore` in `@smithy-hono/adapter-node` is the
 * optional cache-grade alternative (RAM-bound, weaker at rich list/filter/count).
 *
 * The store mirrors the adapter-cf D1 store almost line-for-line — both are SQL,
 * so the SEMANTIC port + real-impl + Map-fake + factory + schema-helper structure
 * is the same. The one Postgres advantage over D1/Redis: a `jsonb` value column
 * means an equality filter on **any** field is a server-side
 * `WHERE value->>'field' = $n` (and `COUNT(*)`) — so there is **NO client-side
 * scan fallback** (unlike Redis). Declared `@persisted(indexes)` are purely a
 * performance optimization: btree expression indexes on `(value->>'field')` that
 * keep the filter sargable at scale; an undeclared filter is still answered
 * server-side, just without a dedicated index.
 *
 * Like the security stores it never imports the `pg` driver: the consumer's real
 * `pg` `Pool`/`Client`, a `postgres.js` client (adapted), or a Neon serverless
 * client structurally satisfies {@link PgClientLike}, and all store logic runs
 * against a narrow SEMANTIC port ({@link PgDataPort}) — never raw SQL — so the
 * conformance fake reimplements the semantics in JS with no SQL parser.
 *
 * Storage model (one entity = one row):
 *   - table {@link PG_TABLE_DEFAULT} (override via `opts.table`), columns:
 *     `scope` (length-prefixed {@link DataScope}), `id` (the entity key),
 *     `value` (`jsonb`, the JSON entity), `version` (`bigint`, the
 *     optimistic-concurrency token), `deleted_at` (`timestamptz` tombstone, only
 *     written when `softDelete`). PRIMARY KEY is `(scope, id)`, so tenant A
 *     literally cannot address tenant B's rows (cross-scope `get` → null), and
 *     the same key in two scopes never collides.
 *   - Declared `@persisted(indexes)` map to btree expression indexes over the
 *     JSONB so a filtered `list`/`count` stays sargable. See
 *     {@link pgCreateTableSql} for the migration the consumer runs.
 */

import {
  OptimisticConflictError,
  type DataScope,
  type DataStore,
  type ListQuery,
  type Page,
  type Stored,
} from '@smithy-hono/data-core'

// ---------------------------------------------------------------------------
// Shared scope + cursor helpers (mirror the adapter-cf D1 DataStore exactly).
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

// ===========================================================================
// PgDataPort — the narrow SEMANTIC surface the Postgres store depends on.
//
// Like adapter-cf's D1DataPort (getRow/insertIfAbsent/updateCas, NOT raw SQL),
// these are SEMANTIC operations — never raw SQL — so the fake port reimplements
// them over a Map with no SQL parser. The REAL port (createPgDataPort) is the
// only place that speaks SQL.
// ===========================================================================

/** A persisted row as the port exchanges it (the store owns the JSON shape). */
export interface PgRow {
  /** The entity key (the resource identifier). */
  id: string
  /** The JSON-serialized entity (without the store-managed `version`). */
  value: string
  /** The optimistic-concurrency version. */
  version: number
  /** ISO tombstone timestamp, or `null` for a live row. */
  deletedAt: string | null
}

/** A query the Postgres port resolves server-side (the store never builds SQL). */
export interface PgListArgs {
  /** Max rows to return (the store asks for `limit + 1` to detect more pages). */
  limit: number
  /** Exclusive lower bound on `id` (the decoded cursor), or undefined for the start. */
  after?: string
  /** Equality filter over JSONB fields (resolved as `value->>'field' = $n` predicates). */
  filter?: Record<string, string | number | boolean>
  /** When true, tombstoned rows are excluded (soft-delete stores). */
  excludeDeleted: boolean
}

/**
 * The minimal SEMANTIC port {@link PostgresDataStore} uses. Implementations MUST
 * preserve the atomicity of {@link updateCas} / {@link deleteCas} (the
 * versioned read-compare-write) and the create-if-absent of
 * {@link insertIfAbsent}.
 */
export interface PgDataPort {
  /** Fetch one row by `(scope, id)`, or `null`. Tombstones are returned (the store hides them). */
  getRow(scope: string, id: string): Promise<PgRow | null>
  /**
   * Create-if-absent. Returns the ASSIGNED version on a write (`1` for a
   * brand-new key or a create after a HARD delete; `tombstone.version + 1` when
   * resurrecting a soft-delete tombstone — the version CONTINUES, never resets),
   * or `null` if a (live) row already existed at `(scope, id)` (atomic
   * `INSERT ... ON CONFLICT DO NOTHING`). `allowOverTombstone` resurrects a
   * tombstoned row (soft-delete create).
   */
  insertIfAbsent(scope: string, row: PgRow, allowOverTombstone: boolean): Promise<number | null>
  /** Unconditional upsert (idempotent `put`). Returns the resulting version. */
  putRow(scope: string, row: PgRow, prevVersion: number | null): Promise<number>
  /**
   * Versioned compare-and-set. Writes `row` only if the current version equals
   * `expectedVersion` (when given) and the row exists+is live. Returns the new
   * version on success, `-1` on miss, `-2` on a version conflict.
   */
  updateCas(scope: string, row: PgRow, expectedVersion: number | undefined): Promise<number>
  /**
   * Versioned delete. Hard-removes (or, when `softDeletePayload` is given,
   * tombstones) the row at `(scope, id)`. Returns the new version on a
   * soft-delete, `0` on a successful hard delete, `-1` on miss, `-2` on conflict.
   */
  deleteCas(
    scope: string,
    id: string,
    expectedVersion: number | undefined,
    softDeletePayload: PgRow | null,
  ): Promise<number>
  /** List rows in a scope, ordered by `id`, honoring filter + cursor. */
  listRows(scope: string, args: PgListArgs): Promise<PgRow[]>
  /** Count rows in a scope honoring the filter (server-side `COUNT(*)`). */
  count(scope: string, filter: Record<string, string | number | boolean> | undefined, excludeDeleted: boolean): Promise<number>
}

/** Reply sentinels from {@link PgDataPort.updateCas} / {@link PgDataPort.deleteCas}. */
const MISS = -1
const CONFLICT = -2

// ---------------------------------------------------------------------------
// PgClientLike — the structural slice of node-postgres we use.
// ---------------------------------------------------------------------------

/**
 * The slice of a node-postgres client {@link createPgDataPort} maps onto. A
 * consumer's real `pg` `Pool`/`Client` is a structural superset — so nothing
 * here imports `pg` (ARCH-01). A `postgres.js` client (adapted to this `query`
 * shape) or a Neon serverless client satisfies it too. Only `query` is used;
 * queries are always parameterized (`$1`, `$2`, ...).
 */
export interface PgClientLike {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
  /**
   * OPTIONAL: check out a single dedicated connection (the node-postgres
   * `Pool.connect()` shape). When present, the `statement_timeout`-scoped read
   * path runs its whole `BEGIN`/`SET LOCAL`/read/`COMMIT` on this ONE connection
   * so the timeout actually applies (a bare `Pool.query()` per statement can land
   * each on a different pooled connection, defeating `SET LOCAL`). Adding this is
   * a backward-compatible widening: a bare `query()`-only client still satisfies
   * the interface and falls back to an untimed read.
   */
  connect?(): Promise<{
    query(
      text: string,
      params?: unknown[],
    ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
    release(err?: unknown): void
  }>
}

// ---------------------------------------------------------------------------
// PostgresDataStore.
// ---------------------------------------------------------------------------

/** Default Postgres table name; override via {@link PostgresDataStoreOptions.table}. */
export const PG_TABLE_DEFAULT = 'data_store'

/** Options for {@link createPostgresDataStore} / {@link PostgresDataStore}. */
export interface PostgresDataStoreOptions {
  /**
   * The Postgres table backing this collection. Default {@link PG_TABLE_DEFAULT}.
   * Used by {@link createPgDataPort} when building SQL; the consumer must have
   * created the table (see {@link pgCreateTableSql}).
   */
  table?: string
  /**
   * Tombstone on delete instead of hard-removing, and hide tombstoned rows from
   * `get`/`list`/`count` (default `false`). Mirrors `@persisted(softDelete:)`.
   */
  softDelete?: boolean
  /**
   * Declared `@persisted` index field names. With Postgres an equality filter on
   * ANY field is a server-side `WHERE value->>'field' = $n` (no client scan, even
   * undeclared) — declaring an index just adds a matching btree expression index
   * (see {@link pgCreateIndexSql}) so the filter stays sargable at scale. Kept for
   * parity with the other adapters.
   */
  indexes?: readonly string[]
  /**
   * OPTIONAL upper bound on a `list`'s effective page size (defense-in-depth). When
   * set, `list` silently CLAMPS `query.limit` down to `maxLimit`
   * (`Math.min(query.limit, maxLimit)`) so a large caller `limit` cannot drive an
   * unbounded scan — it does NOT reject the request. Unset (default) means NO clamp:
   * behavior is identical to before this knob existed. The clamp only lowers rows
   * returned per page; the opaque resume-cursor contract is unchanged.
   */
  maxLimit?: number
}

class PostgresDataStore<T extends Record<string, unknown>> implements DataStore<T> {
  readonly #port: PgDataPort
  readonly #softDelete: boolean
  /** Declared `@persisted` index fields (for the undeclared-filter warn/refuse guard). */
  readonly #indexes: ReadonlySet<string>
  readonly #maxLimit: number | undefined

  constructor(port: PgDataPort, opts: PostgresDataStoreOptions = {}) {
    this.#port = port
    this.#softDelete = opts.softDelete ?? false
    this.#indexes = new Set(opts.indexes ?? [])
    this.#maxLimit = opts.maxLimit
  }

  /** Filter field names that are NOT declared indexes (force a sequential scope scan). */
  #undeclaredFilterFields(
    filter: Record<string, string | number | boolean> | undefined,
  ): string[] {
    return filter ? Object.keys(filter).filter((f) => !this.#indexes.has(f)) : []
  }

  async get(key: string, scope: DataScope): Promise<Stored<T> | null> {
    const row = await this.#port.getRow(scopeSeg(scope), key)
    if (row === null) return null
    if (row.deletedAt !== null) return null // tombstone invisible
    return this.#decode(row)
  }

  async create(key: string, value: T, scope: DataScope): Promise<Stored<T>> {
    // The port assigns the version: 1 for a brand-new key (or create after a HARD
    // delete), tombstone.version + 1 when resurrecting a soft-delete tombstone.
    const version = await this.#port.insertIfAbsent(
      scopeSeg(scope),
      { id: key, value: JSON.stringify(this.#strip(value)), version: 1, deletedAt: null },
      this.#softDelete,
    )
    if (version === null) {
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
    let payload: PgRow | null = null
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
    // A non-positive limit would silently make all data unreachable — fail fast.
    if (query.limit < 1) throw new RangeError('list limit must be >= 1')
    // Optional defense-in-depth clamp: lower the effective page size to maxLimit
    // when configured. Unset = no clamp = identical to the prior behavior.
    const effectiveLimit =
      this.#maxLimit !== undefined ? Math.min(query.limit, this.#maxLimit) : query.limit
    // An undeclared filter field has no btree expression index → a sequential scan
    // of the scope partition before the LIMIT applies. Warn (matching adapter-node)
    // so operators see the unindexed scan; the LIMIT + optional statement_timeout
    // bound it.
    const undeclared = this.#undeclaredFilterFields(query.filter)
    if (undeclared.length > 0) {
      console.warn(
        `[adapter-postgres] DataStore.list: filtering on non-declared index ` +
          `${undeclared.join(',')} via a sequential scope scan; declare it in ` +
          `@persisted(indexes) for a sargable btree expression index.`,
      )
    }
    const after = query.cursor ? decodeCursor(query.cursor) : undefined
    // Ask for one extra row to know whether a further page exists.
    const rows = await this.#port.listRows(scopeSeg(scope), {
      limit: effectiveLimit + 1,
      after,
      filter: query.filter,
      excludeDeleted: this.#softDelete,
    })
    const page = rows.slice(0, effectiveLimit)
    const items = page.map((r) => this.#decode(r))
    const hasMore = rows.length > effectiveLimit
    const cursor =
      hasMore && page.length > 0 ? encodeCursor(page[page.length - 1].id) : undefined
    return cursor ? { items, cursor } : { items }
  }

  async count(
    query: Omit<ListQuery, 'cursor' | 'limit'>,
    scope: DataScope,
  ): Promise<number> {
    // `count` must be EXACT, so an undeclared-filter scan can't be silently
    // row-capped (a capped count would lie). Refuse it loudly — mirroring
    // adapter-aws — so the field is declared in @persisted(indexes) for a
    // server-side, index-backed count.
    const undeclared = this.#undeclaredFilterFields(query.filter)
    if (undeclared.length > 0) {
      throw new Error(
        `[adapter-postgres] DataStore.count: an exact count on a non-declared index ` +
          `(${undeclared.join(',')}) would require an unbounded sequential scope scan; ` +
          `declare it in @persisted(indexes) for a server-side index count.`,
      )
    }
    return this.#port.count(scopeSeg(scope), query.filter, this.#softDelete)
  }

  // --- internals ----------------------------------------------------------

  /** Reconstruct a {@link Stored} envelope from a row's JSON + version. */
  #decode(row: PgRow): Stored<T> {
    const obj = JSON.parse(row.value) as Record<string, unknown>
    return { ...obj, version: row.version } as Stored<T>
  }

  /**
   * Drop the store-managed `version` and `deletedAt` from the persisted JSON —
   * `version` lives in its own column and `deletedAt` in `deleted_at`, so neither
   * belongs in the value blob (and dropping `deletedAt` stops a caller injecting
   * one to forge a tombstone, matching the memory store).
   */
  #strip(stored: Stored<T> | T): Record<string, unknown> {
    const { version: _v, deletedAt: _d, ...rest } = stored as Record<string, unknown>
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
// Postgres schema helpers (the consumer runs these as a migration).
// ---------------------------------------------------------------------------

/**
 * The `CREATE TABLE` for a Postgres-backed {@link DataStore}. The consumer runs
 * this once (a migration) per collection — the adapter never issues DDL at
 * runtime.
 *
 *   - `(scope, id)` is the composite PRIMARY KEY → cross-scope get returns
 *     nothing, same key in two scopes never collides.
 *   - `value` is `jsonb`, so an equality filter on ANY field is a server-side
 *     `value->>'field' = $n`; declared indexes are btree expressions over it
 *     (see {@link pgCreateIndexSql}).
 *   - `version` is `bigint` (the optimistic-concurrency token).
 *   - `deleted_at` is NULL for live rows; a tombstone `timestamptz` when soft-deleted.
 *
 * @param table the table name (default {@link PG_TABLE_DEFAULT}); must match the
 *   `opts.table` passed to {@link createPostgresDataStore} / {@link createPgDataPort}.
 */
export function pgCreateTableSql(table: string = PG_TABLE_DEFAULT): string {
  const t = quoteIdent(table)
  return (
    `CREATE TABLE IF NOT EXISTS ${t} (\n` +
    `  scope text NOT NULL,\n` +
    `  id text NOT NULL,\n` +
    `  value jsonb NOT NULL,\n` +
    `  version bigint NOT NULL,\n` +
    `  deleted_at timestamptz,\n` +
    `  PRIMARY KEY (scope, id)\n` +
    `);`
  )
}

/**
 * A btree expression index for one declared `@persisted` index field, so an
 * equality `filter` on it stays sargable in SQL. Mirrors the adapter-cf D1
 * computed-column index. The consumer runs this alongside {@link pgCreateTableSql}.
 *
 * @example pgCreateIndexSql('data_store', 'ownerId')
 */
export function pgCreateIndexSql(table: string, field: string): string {
  const safeTable = table.replace(/[^A-Za-z0-9_]/g, '_')
  const safeField = field.replace(/[^A-Za-z0-9_]/g, '_')
  // Sanitizing punctuation to `_` collapses distinct fields (`a.b` vs `a-b`) onto
  // the same name; with IF NOT EXISTS the second would silently get no index.
  // A short hash of the RAW field keeps each declared index distinct.
  const suffix = fieldNameHash(field)
  return (
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(`${safeTable}_idx_${safeField}_${suffix}`)} ` +
    `ON ${quoteIdent(table)} (scope, (value->>${quoteLiteral(field)}));`
  )
}

/** Short, stable hex hash of a raw field name (disambiguates index names). */
function fieldNameHash(field: string): string {
  // FNV-1a (32-bit) — tiny, dependency-free, stable across runs.
  let h = 0x811c9dc5
  for (let i = 0; i < field.length; i++) {
    h ^= field.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------------------
// Real Postgres port — the ONLY place that speaks SQL (ARCH-01: structural client).
// ---------------------------------------------------------------------------

/** Quote a SQL identifier (table / index name) — doubles embedded quotes. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** Quote a SQL string literal (used only for the static field name in DDL). */
function quoteLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/**
 * Build an equality predicate list from a filter, starting bind placeholders at
 * `startIndex`.
 *
 * The comparison is TYPED to the JS filter value so it matches the stored JSON
 * value the way `@persisted` callers expect — NOT via `->>`'s text projection,
 * which silently diverges from `String(value)` for exotic numbers (`1e21` →
 * `'1000000000000000000000'` vs `'1e+21'`, `0.0000001` → `'0.0000001'` vs
 * `'1e-7'`, `1.10` → `'1.10'` vs `'1.1'`) and would return NO rows:
 *   - number  → `jsonb_typeof(value->'field') = 'number' AND (value->'field')::numeric = $n::numeric`
 *   - boolean → `jsonb_typeof(value->'field') = 'boolean' AND (value->'field')::boolean = $n::boolean`
 *   - string  → `value->>'field' = $n` (text; `->>` IS the canonical text here)
 *
 * The `jsonb_typeof(...) = '...'` guard is what makes the numeric/boolean cast
 * safe for mixed-type rows: a row whose field is absent, null, or a different
 * type fails the guard and is filtered out by short-circuit BEFORE the `::numeric`
 * / `::boolean` cast is reached, so an unrelated row never raises a cast error.
 */
function filterPredicates(
  filter: Record<string, string | number | boolean> | undefined,
  startIndex: number,
): { sql: string; binds: unknown[]; next: number } {
  if (!filter) return { sql: '', binds: [], next: startIndex }
  const clauses: string[] = []
  const binds: unknown[] = []
  let n = startIndex
  for (const [field, value] of Object.entries(filter)) {
    const path = `value->${quoteLiteral(field)}`
    if (typeof value === 'number') {
      // typeof guard short-circuits before the cast → cast-safe for mixed rows.
      clauses.push(`(jsonb_typeof(${path}) = 'number' AND (${path})::numeric = $${n}::numeric)`)
      binds.push(value)
    } else if (typeof value === 'boolean') {
      clauses.push(`(jsonb_typeof(${path}) = 'boolean' AND (${path})::boolean = $${n}::boolean)`)
      binds.push(value)
    } else {
      // String value: `->>` IS the canonical text, so a text compare is exact.
      clauses.push(`value->>${quoteLiteral(field)} = $${n}`)
      binds.push(value)
    }
    n++
  }
  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', binds, next: n }
}

export interface PgDataPortOptions {
  /**
   * Per-query `statement_timeout` (ms) applied to the `list`/`count` read
   * statements via a transaction-scoped `SET LOCAL`, so a single pathological
   * unindexed scan cannot run unbounded. Omit (or `0`) to leave the
   * server/pool default in force.
   */
  statementTimeoutMs?: number
}

/**
 * Build the REAL {@link PgDataPort} over a structural {@link PgClientLike}. This
 * is the only SQL in the adapter; the store logic stays SQL-free.
 *
 * Versioned writes are a single conditional `UPDATE ... WHERE scope=$ AND id=$
 * AND version=$ AND deleted_at IS NULL` — Postgres runs each statement
 * atomically, so `rowCount === 0` means "no row matched the version"; a follow-up
 * `SELECT` disambiguates miss vs {@link CONFLICT}. Create is `INSERT ... ON
 * CONFLICT (scope, id) DO NOTHING` (0 rows ⇒ already exists; the soft-delete
 * variant `DO UPDATE ... WHERE deleted_at IS NOT NULL` resurrects a tombstone).
 *
 * Production wiring: `createPgDataPort(new Pool({ connectionString }))`.
 *
 * @param client the consumer's `pg` `Pool`/`Client` (structural).
 * @param table the table name; must match {@link createPostgresDataStore}'s `opts.table`.
 * @param opts.statementTimeoutMs optional per-query `statement_timeout` for reads.
 */
export function createPgDataPort(
  client: PgClientLike,
  table: string = PG_TABLE_DEFAULT,
  opts: PgDataPortOptions = {},
): PgDataPort {
  const t = quoteIdent(table)
  const statementTimeoutMs = opts.statementTimeoutMs ?? 0

  /**
   * Run a read query (`list`/`count`) under an optional `statement_timeout`. When
   * a timeout is configured we wrap the single statement in a transaction so
   * `SET LOCAL` scopes the timeout to JUST this query (and resets on COMMIT/
   * ROLLBACK).
   *
   * ⚠️ The transaction MUST run on a single dedicated connection: with a
   * node-postgres `Pool`, each `Pool.query()` checks out a possibly-different
   * pooled connection, so `BEGIN`, `SET LOCAL`, the SELECT and `COMMIT` could
   * land on different backends — the timeout would not apply and the BEGIN's
   * connection would be returned idle-in-transaction. So when the client exposes
   * `connect()` we check out ONE connection and run the whole transaction on it
   * (releasing with the error on the failure path so the pool discards the
   * in-transaction connection). A bare `query()`-only client (no `connect`) can't
   * safely scope `SET LOCAL`, so it falls back to a plain untimed read.
   */
  const runRead = async (
    text: string,
    binds: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> => {
    if (statementTimeoutMs <= 0 || client.connect === undefined) {
      return client.query(text, binds)
    }
    const conn = await client.connect()
    try {
      await conn.query('BEGIN')
      await conn.query(`SET LOCAL statement_timeout = ${Math.floor(statementTimeoutMs)}`)
      const res = await conn.query(text, binds)
      await conn.query('COMMIT')
      conn.release()
      return res
    } catch (err) {
      // Release WITH the error so the pool discards this connection rather than
      // returning it idle-in-transaction (no ROLLBACK round-trip needed).
      conn.release(err)
      throw err
    }
  }

  const toRow = (r: Record<string, unknown> | undefined): PgRow | null => {
    if (!r) return null
    // `value` is jsonb: node-postgres parses it to an object, so re-serialize to
    // the JSON string the store's #decode expects. (A `postgres.js`/Neon client
    // may already hand back a string — handle both.)
    const value = typeof r.value === 'string' ? r.value : JSON.stringify(r.value)
    const deleted = r.deleted_at
    return {
      id: String(r.id),
      value,
      version: Number(r.version),
      deletedAt:
        deleted === null || deleted === undefined
          ? null
          : deleted instanceof Date
            ? deleted.toISOString()
            : String(deleted),
    }
  }

  const selectOne = async (scope: string, id: string): Promise<PgRow | null> => {
    const res = await client.query(
      `SELECT id, value, version, deleted_at FROM ${t} WHERE scope = $1 AND id = $2`,
      [scope, id],
    )
    return toRow(res.rows[0])
  }

  return {
    async getRow(scope, id) {
      return selectOne(scope, id)
    },

    async insertIfAbsent(scope, row, allowOverTombstone) {
      // INSERT-if-absent. When soft-delete create-over-tombstone is allowed, the
      // ON CONFLICT path resurrects a tombstoned row (deleted_at IS NOT NULL) but
      // still refuses to overwrite a LIVE row (the WHERE keeps create exclusive).
      const onConflict = allowOverTombstone
        ? ` ON CONFLICT (scope, id) DO UPDATE SET value = excluded.value, ` +
          // CONTINUE the version off the tombstone (never reset to 1) so a
          // resurrected row never reuses a version a stale holder still has.
          `version = ${t}.version + 1, deleted_at = NULL WHERE ${t}.deleted_at IS NOT NULL`
        : ` ON CONFLICT (scope, id) DO NOTHING`
      const res = await client.query(
        `INSERT INTO ${t} (scope, id, value, version, deleted_at) ` +
          `VALUES ($1, $2, $3::jsonb, $4, NULL)` +
          onConflict +
          // RETURNING the assigned version surfaces the CONTINUED tombstone version
          // (or 1 for a fresh insert); 0 rows ⇒ a live row blocked the create.
          ` RETURNING version`,
        [scope, row.id, row.value, row.version],
      )
      const r = res.rows[0]
      return r ? Number(r.version) : null
    },

    async putRow(scope, row, prevVersion) {
      const newVersion = prevVersion === null ? 1 : prevVersion + 1
      await client.query(
        `INSERT INTO ${t} (scope, id, value, version, deleted_at) ` +
          `VALUES ($1, $2, $3::jsonb, $4, NULL) ` +
          `ON CONFLICT (scope, id) DO UPDATE SET value = excluded.value, ` +
          `version = excluded.version, deleted_at = NULL`,
        [scope, row.id, row.value, newVersion],
      )
      return newVersion
    },

    async updateCas(scope, row, expectedVersion) {
      // Read the live row to disambiguate miss vs conflict (rowCount alone can't
      // tell them apart). The conditional UPDATE then enforces the CAS atomically
      // — a racing writer still flips rowCount to 0.
      const cur = await selectOne(scope, row.id)
      if (!cur || cur.deletedAt !== null) return MISS
      const guard = expectedVersion === undefined ? cur.version : expectedVersion
      const res = await client.query(
        `UPDATE ${t} SET value = $1::jsonb, version = version + 1 ` +
          `WHERE scope = $2 AND id = $3 AND version = $4 AND deleted_at IS NULL`,
        [row.value, scope, row.id, guard],
      )
      if ((res.rowCount ?? 0) === 0) return CONFLICT
      return guard + 1
    },

    async deleteCas(scope, id, expectedVersion, softDeletePayload) {
      const cur = await selectOne(scope, id)
      if (!cur || cur.deletedAt !== null) return MISS
      if (expectedVersion !== undefined && cur.version !== expectedVersion) return CONFLICT
      const guard = cur.version
      if (softDeletePayload) {
        const res = await client.query(
          `UPDATE ${t} SET deleted_at = $1, version = version + 1 ` +
            `WHERE scope = $2 AND id = $3 AND version = $4 AND deleted_at IS NULL`,
          [softDeletePayload.deletedAt, scope, id, guard],
        )
        if ((res.rowCount ?? 0) === 0) return CONFLICT
        return guard + 1
      }
      const res = await client.query(
        `DELETE FROM ${t} WHERE scope = $1 AND id = $2 AND version = $3`,
        [scope, id, guard],
      )
      if ((res.rowCount ?? 0) === 0) return CONFLICT
      return 0
    },

    async listRows(scope, args) {
      const { sql: filterSql, binds: filterBinds, next } = filterPredicates(args.filter, 2)
      const binds: unknown[] = [scope, ...filterBinds]
      let n = next
      const deletedSql = args.excludeDeleted ? ` AND deleted_at IS NULL` : ''
      let afterSql = ''
      if (args.after !== undefined) {
        afterSql = ` AND id > $${n}`
        binds.push(args.after)
        n++
      }
      const limitPlaceholder = `$${n}`
      binds.push(args.limit)
      const res = await runRead(
        `SELECT id, value, version, deleted_at FROM ${t} ` +
          `WHERE scope = $1${filterSql}${deletedSql}${afterSql} ORDER BY id ASC LIMIT ${limitPlaceholder}`,
        binds,
      )
      return res.rows.map((r) => toRow(r)!).filter((r): r is PgRow => r !== null)
    },

    async count(scope, filter, excludeDeleted) {
      const { sql: filterSql, binds: filterBinds } = filterPredicates(filter, 2)
      const deletedSql = excludeDeleted ? ` AND deleted_at IS NULL` : ''
      const res = await runRead(
        `SELECT COUNT(*) AS n FROM ${t} WHERE scope = $1${filterSql}${deletedSql}`,
        [scope, ...filterBinds],
      )
      const r = res.rows[0]
      return r ? Number(r.n) : 0
    },
  }
}

// ---------------------------------------------------------------------------
// Fake Postgres port — in-process Map, reimplements the semantics (no SQL parser).
// ---------------------------------------------------------------------------

/**
 * An in-process {@link PgDataPort} backed by a `Map`. Reimplements the CAS /
 * create-if-absent / filtered-list semantics in JS — exactly as adapter-cf's
 * `createFakeD1DataPort` reimplements the SQL CAS — so the always-on conformance
 * suite exercises all store logic with no Postgres. The real SQL is validated by
 * `live.postgres.dataStore.test.ts` in CI.
 *
 * Each call runs its read-compare-write in one synchronous section before the
 * returned promise settles, so there is no interleaving (JS single-thread), the
 * same atomicity Postgres gives per statement.
 */
export function createFakePgDataPort(): PgDataPort {
  /** `${scope} ${id}` → row. */
  const rows = new Map<string, PgRow>()
  const k = (scope: string, id: string): string => `${scope} ${id}`

  const liveMatches = (
    row: PgRow,
    scope: string,
    filter: Record<string, string | number | boolean> | undefined,
    excludeDeleted: boolean,
    afterId: string | undefined,
    scopeKey: string,
  ): boolean => {
    if (!scopeKey.startsWith(`${scope} `)) return false
    if (excludeDeleted && row.deletedAt !== null) return false
    if (afterId !== undefined && !(row.id > afterId)) return false
    if (filter) {
      const obj = JSON.parse(row.value) as Record<string, unknown>
      for (const [field, want] of Object.entries(filter)) {
        // Both sides are real parsed JS values here (stored value + filter value),
        // so compare them with strict equality — matching the REAL port's TYPED
        // comparison (numbers/booleans compared as values, not via `String()`,
        // which diverges from Postgres `->>` text for exotic numbers).
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
      if (cur && !(allowOverTombstone && cur.deletedAt !== null)) return null
      // Resurrecting a tombstone CONTINUES the version (mirrors the real port's
      // `version = <table>.version + 1`); a fresh insert starts at 1.
      const version = cur ? cur.version + 1 : 1
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
      const out: PgRow[] = []
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
// Postgres factory.
// ---------------------------------------------------------------------------

/**
 * Construct a Postgres-backed {@link DataStore} over a {@link PgDataPort}. Like
 * the security stores, the logic lives only against the port, so the same class
 * passes the `@smithy-hono/data-core` conformance suite against the in-process
 * fake AND runs unchanged against real Postgres in production.
 *
 * Full capabilities: optimistic concurrency (SQL CAS), equality filter + count on
 * ANY field (server-side `WHERE value->>'field' = $n` / `COUNT(*)` — no client
 * scan), opaque-cursor pagination, and (opt-in) soft-delete.
 *
 * @example
 *   const store = createPostgresDataStore(
 *     createPgDataPort(new Pool({ connectionString }), 'todos'),
 *     { table: 'todos', indexes: ['ownerId'], softDelete: false },
 *   )
 */
export function createPostgresDataStore<
  T extends Record<string, unknown> = Record<string, unknown>,
>(port: PgDataPort, opts: PostgresDataStoreOptions = {}): DataStore<T> {
  return new PostgresDataStore<T>(port, opts)
}

export { PostgresDataStore }
