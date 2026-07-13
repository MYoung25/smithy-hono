/**
 * `DataStore<T>` (Plan 13 — default DB-backed CRUD) over Amazon DynamoDB, behind
 * a narrow structural client (ARCH-01).
 *
 * This is the full-featured DynamoDB analog of the adapter-cf D1 store: DynamoDB
 * gives strongly-consistent (with `ConsistentRead`), conditional writes, so it
 * supports the WHOLE {@link DataStore} contract — optimistic concurrency (a
 * version-guarded conditional `Put`/`Update` whose `ConditionalCheckFailed` we
 * surface as {@link OptimisticConflictError}), opaque-cursor pagination (native
 * `LastEvaluatedKey`), `count` (a `Query` with `Select: 'COUNT'`), soft-delete
 * tombstones, and an equality `filter` (served by a GSI for declared
 * `@persisted(indexes)` fields, else a `Query` + `FilterExpression` — documented
 * below). Like the security stores it never imports `@aws-sdk/*`: the consumer's
 * real `DynamoDBDocumentClient` structurally satisfies {@link DynamoSendLike},
 * and all store logic runs against a narrow SEMANTIC port ({@link DynamoDataPort})
 * — never raw commands — so the conformance fake reimplements the semantics over
 * a `Map` with no command interpretation.
 *
 * **A SEPARATE TABLE from the security store.** The security `DynamoTablePort`
 * (`port.ts`) is KEY-ONLY (a single `pk` partition key, no sort key, no
 * list/query/count). A {@link DataStore} needs `list` ordered by id within a
 * scope, so the DataStore OWNS ITS OWN table with a partition+sort key schema
 * (see {@link DDB_DATA_TABLE_DEFAULT} / {@link describeDataTable}). The two share
 * the {@link DynamoSendLike}/`toCommand` plumbing from `dynamoPort.ts` (extended
 * with a `Query` command tag) but not a table.
 *
 * Storage model (one entity = one item):
 *   - Partition key `pk` = the length-prefixed {@link DataScope} segment, so a
 *     `Query` for scope A literally cannot see scope B's items (cross-scope `get`
 *     → null) and the same id in two scopes never collides.
 *   - Sort key `sk` = the entity id → a scope is one contiguous partition; `list`
 *     is a `Query` ordered by `sk` with native `LastEvaluatedKey` pagination.
 *   - `version` (Number) — the optimistic-concurrency token, managed by the port.
 *   - `deletedAt` (String, ISO) — written only on a soft-delete; live items omit it.
 *   - GSIs: one per declared `@persisted` index field, keyed
 *     `gsi_<field>_pk = "<pk>#<value>"` (partition = scope+value) + `sk` (so a
 *     filtered `list` Querys the GSI within one scope, ordered by id). See
 *     {@link describeDataTable} for the full key schema an IaC template must create.
 *   - No `ttl`: CRUD entities are not time-evicted (the security store uses `ttl`
 *     for sessions/nonces; a DataStore entity lives until deleted). Noted here so
 *     an IaC author does not enable TTL on this table.
 */

import {
  OptimisticConflictError,
  type DataScope,
  type DataStore,
  type ListQuery,
  type Page,
  type Stored,
} from '@smithy-hono/data-core'
import type { DynamoSendLike } from './dynamoPort.js'

// ---------------------------------------------------------------------------
// Shared scope + cursor helpers (mirror the adapter-cf / adapter-node stores).
// ---------------------------------------------------------------------------

/** Length-prefixed scope segment (collision-proof, mirrors the other adapters). */
function scopeSeg(scope: DataScope): string {
  const t = scope.tenantId ?? ''
  const o = scope.ownerId ?? ''
  return `${t.length}:${t}|${o.length}:${o}`
}

/** Opaque base64 cursor of the last entity id emitted — NEVER an offset. */
function encodeCursor(lastId: string): string {
  return btoa(unescape(encodeURIComponent(lastId)))
}
function decodeCursor(cursor: string): string {
  return decodeURIComponent(escape(atob(cursor)))
}

// ---------------------------------------------------------------------------
// DynamoDataPort — the narrow SEMANTIC surface the DynamoDB store depends on.
//
// Mirrors adapter-cf's D1DataPort exactly (same method shape), so the store /
// factory code below reads in parallel with the cf adapter. These are SEMANTIC
// operations — never raw DynamoDB commands — so the fake port reimplements them
// over a Map. The REAL port (createDynamoDataPort) is the only place that speaks
// the DynamoSendLike command protocol.
// ---------------------------------------------------------------------------

/** A persisted row as the port exchanges it (the store owns the JSON shape). */
export interface DynamoRow {
  /** The entity id (the resource identifier; the table's sort key). */
  id: string
  /** The JSON-serialized entity (without the store-managed `version`). */
  value: string
  /** The optimistic-concurrency version. */
  version: number
  /** ISO tombstone timestamp, or `null` for a live row. */
  deletedAt: string | null
}

/** A query the Dynamo port resolves server-side (the store never builds commands). */
export interface DynamoListArgs {
  /** Max rows to return (the store asks for `limit + 1` to detect more pages). */
  limit: number
  /** Exclusive lower bound on `id` (the decoded cursor), or undefined for the start. */
  after?: string
  /** Equality filter over entity fields. */
  filter?: Record<string, string | number | boolean>
  /**
   * A declared `@persisted` index field whose GSI serves the filter, or undefined
   * to filter via a partition `Query` + `FilterExpression` (see {@link createDynamoDataPort}).
   */
  index?: string
  /** When true, tombstoned rows are excluded (soft-delete stores). */
  excludeDeleted: boolean
}

/**
 * The minimal SEMANTIC port {@link createDynamoDataStore} uses. Implementations
 * MUST preserve the atomicity of {@link updateCas} / {@link deleteCas} (the
 * versioned read-compare-write, a conditional write under the hood) and the
 * create-if-absent of {@link insertIfAbsent}.
 */
export interface DynamoDataPort {
  /** Fetch one row by `(scope, id)`, or `null`. Tombstones are returned (the store hides them). */
  getRow(scope: string, id: string): Promise<DynamoRow | null>
  /**
   * Create-if-absent. Returns the assigned version if inserted, or `null` if a
   * LIVE row already existed at `(scope, id)` (a conditional `Put` on
   * `attribute_not_exists`). `allowOverTombstone` permits resurrecting a
   * tombstoned row (soft-delete create); resurrection CONTINUES the version
   * (tombstone.version + 1), it does NOT reset to 1. A brand-new key (or a create
   * after a HARD delete) gets version 1.
   */
  insertIfAbsent(scope: string, row: DynamoRow, allowOverTombstone: boolean): Promise<number | null>
  /**
   * Unconditional, ATOMIC upsert (idempotent `put`). Increments the version in a
   * single DynamoDB `UpdateItem` (`version = if_not_exists(version, 0) + 1`) — no
   * read, no retry loop — so concurrent puts are monotonic. Resurrects a tombstone
   * (clears `deletedAt`) and CONTINUES the version. Returns the resulting version.
   */
  putRow(scope: string, row: DynamoRow): Promise<number>
  /**
   * Versioned compare-and-set. Writes `row` only if the current version equals
   * `expectedVersion` (when given) and the row exists+is live. Returns the new
   * version on success, `-1` on miss, `-2` on a version conflict.
   */
  updateCas(scope: string, row: DynamoRow, expectedVersion: number | undefined): Promise<number>
  /**
   * Versioned delete. Hard-removes (or, when `softDeletePayload` is given,
   * tombstones) the row at `(scope, id)`. Returns the new version on a
   * soft-delete, `0` on a successful hard delete, `-1` on miss, `-2` on conflict.
   */
  deleteCas(
    scope: string,
    id: string,
    expectedVersion: number | undefined,
    softDeletePayload: DynamoRow | null,
  ): Promise<number>
  /**
   * List rows in a scope, ordered by `id`, honoring filter + cursor. Returns the
   * matching rows; `nextAfter` is the id to resume past when the scan stopped
   * early at the undeclared-filter cap (see {@link createDynamoDataPort}) with
   * more of the partition unscanned — the store turns it into a continuation
   * cursor for a partial page. Undefined when the partition/index was drained.
   */
  listRows(scope: string, args: DynamoListArgs): Promise<{ rows: DynamoRow[]; nextAfter?: string }>
  /**
   * Count rows in a scope honoring the filter (server-side `Select: 'COUNT'`).
   * An exact count over an UNDECLARED filter would need an uncapped partition
   * scan, so it THROWS — declare the field in `@persisted(indexes)` for a
   * server-side GSI count (see {@link createDynamoDataPort}).
   */
  count(
    scope: string,
    filter: Record<string, string | number | boolean> | undefined,
    index: string | undefined,
    excludeDeleted: boolean,
  ): Promise<number>
}

/** Reply sentinels from {@link DynamoDataPort.updateCas} / {@link DynamoDataPort.deleteCas}. */
const MISS = -1
const CONFLICT = -2

/**
 * Cap on items SCANNED by the undeclared-filter fallback (a base-table partition
 * `Query` + client-side post-filter), mirroring adapter-node's `SCAN_CAP`. A
 * filter with NO declared GSI reads the whole scope partition and matches the
 * residual fields client-side (DynamoDB can't `FilterExpression` inside the
 * opaque `value` blob) — unbounded latency/RCU at scale. We stop after scanning
 * this many items: `list` returns the matches found so far WITH a continuation
 * cursor (a partial page), and `count` (which must be EXACT) refuses entirely.
 * Declared-index (GSI) filters are server-side and unaffected by this cap.
 */
const SCAN_CAP = 10_000

// ===========================================================================
// DynamoDataStore — the store class (SQL/command-free; depends only on the port).
// ===========================================================================

/** Default DynamoDB table name; override via {@link DynamoDataStoreOptions.table}. */
export const DDB_DATA_TABLE_DEFAULT = 'data_store'

/** Options for {@link createDynamoDataStore}. */
export interface DynamoDataStoreOptions {
  /**
   * The DynamoDB table backing this collection. Default
   * {@link DDB_DATA_TABLE_DEFAULT}. Used by {@link createDynamoDataPort}; the
   * consumer must have created the table + GSIs (see {@link describeDataTable}).
   */
  table?: string
  /**
   * Tombstone on delete instead of hard-removing, and hide tombstoned rows from
   * `get`/`list`/`count` (default `false`). Mirrors `@persisted(softDelete:)`.
   */
  softDelete?: boolean
  /**
   * Declared `@persisted` index field names. Each maps to a GSI
   * (`gsi_<field>_pk`/`sk`, see {@link describeDataTable}); an equality `filter`
   * on a declared field Querys that GSI (server-side, sargable). An UNDECLARED
   * filter falls back to a partition `Query` + `FilterExpression` (documented in
   * {@link createDynamoDataPort}).
   */
  indexes?: readonly string[]
  /**
   * OPTIONAL upper bound on a `list`'s effective page size (defense-in-depth). When
   * set, `list` silently CLAMPS `query.limit` down to `maxLimit`
   * (`Math.min(query.limit, maxLimit)`) BEFORE forwarding `limit + 1` to DynamoDB,
   * so a large caller `limit` cannot drive an unbounded partition scan — it does NOT
   * reject the request. Unset (default) means NO clamp: behavior is identical to
   * before this knob existed. The clamp only lowers rows returned per page; the
   * opaque resume-cursor contract (native `LastEvaluatedKey`) is unchanged.
   */
  maxLimit?: number
}

class DynamoDataStore<T extends Record<string, unknown>> implements DataStore<T> {
  readonly #port: DynamoDataPort
  readonly #softDelete: boolean
  readonly #indexes: ReadonlySet<string>
  readonly #maxLimit: number | undefined

  constructor(port: DynamoDataPort, opts: DynamoDataStoreOptions = {}) {
    this.#port = port
    this.#softDelete = opts.softDelete ?? false
    this.#indexes = new Set(opts.indexes ?? [])
    this.#maxLimit = opts.maxLimit
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
    // Atomic in the port (single UpdateItem with `if_not_exists(version) + 1`),
    // so concurrent puts are monotonic and a put over a tombstone continues the
    // version — no read-then-write race.
    const newVersion = await this.#port.putRow(scopeSeg(scope), {
      id: key,
      value: JSON.stringify(this.#strip(value)),
      version: 0,
      deletedAt: null,
    })
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
    let payload: DynamoRow | null = null
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
    if (query.limit < 1) {
      // limit:0 would silently make all data unreachable — fail fast instead.
      throw new RangeError('list limit must be >= 1')
    }
    // Optional defense-in-depth clamp: lower the effective page size to maxLimit
    // when configured, BEFORE the `+ 1` extra-row arithmetic below. Unset = no
    // clamp = identical to the prior behavior.
    const effectiveLimit =
      this.#maxLimit !== undefined ? Math.min(query.limit, this.#maxLimit) : query.limit
    // A malformed cursor (bad base64 / bad UTF-8) makes decodeCursor throw a raw
    // DOMException/URIError; normalize it to the same typed RangeError the limit<1
    // path uses so client input surfaces one 4xx class, not an uncaught 500.
    let after: string | undefined
    if (query.cursor) {
      try {
        after = decodeCursor(query.cursor)
      } catch {
        throw new RangeError('invalid cursor')
      }
    }
    // Ask for one extra row to know whether a further page exists.
    const { rows, nextAfter } = await this.#port.listRows(scopeSeg(scope), {
      limit: effectiveLimit + 1,
      after,
      filter: query.filter,
      index: this.#indexFor(query),
      excludeDeleted: this.#softDelete,
    })
    const page = rows.slice(0, effectiveLimit)
    const items = page.map((r) => this.#decode(r))
    const hasMore = rows.length > effectiveLimit
    // A full page → resume past its last row. A short page that the port capped
    // mid-scan (nextAfter set) → resume past the last SCANNED id so the next call
    // continues the partition rather than dropping the unscanned tail.
    let cursor: string | undefined
    if (hasMore && page.length > 0) {
      cursor = encodeCursor(page[page.length - 1].id)
    } else if (nextAfter !== undefined) {
      cursor = encodeCursor(nextAfter)
    }
    return cursor ? { items, cursor } : { items }
  }

  async count(
    query: Omit<ListQuery, 'cursor' | 'limit'>,
    scope: DataScope,
  ): Promise<number> {
    return this.#port.count(
      scopeSeg(scope),
      query.filter,
      this.#indexFor(query),
      this.#softDelete,
    )
  }

  // --- internals ----------------------------------------------------------

  /**
   * Pick the GSI to serve a filtered query: the declared index named on the
   * query, else the first filter field that maps to a declared index. Returns
   * undefined when no declared index applies → the port falls back to a
   * partition `Query` + `FilterExpression`.
   */
  #indexFor(query: { filter?: Record<string, unknown>; index?: string }): string | undefined {
    if (query.index && this.#indexes.has(query.index)) return query.index
    if (query.filter) {
      for (const field of Object.keys(query.filter)) {
        if (this.#indexes.has(field)) return field
      }
    }
    return undefined
  }

  /** Reconstruct a {@link Stored} envelope from a row's JSON + version. */
  #decode(row: DynamoRow): Stored<T> {
    const obj = JSON.parse(row.value) as Record<string, unknown>
    return { ...obj, version: row.version } as Stored<T>
  }

  /** Drop the store-managed `version` from the persisted JSON (it lives in its attr). */
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
// Table schema description (the consumer creates this in their infra-as-code).
// ---------------------------------------------------------------------------

/** A GSI an IaC template must create for one declared index field. */
export interface DynamoGsiSchema {
  /** The declared `@persisted` index field this GSI serves. */
  field: string
  /** The GSI index name (the value passed to `Query`'s `IndexName`). */
  indexName: string
  /** The GSI partition-key attribute (`"<pk>#<value>"`). */
  partitionKey: string
  /** The GSI sort-key attribute (the entity id). */
  sortKey: string
}

/** The base-table + GSI schema a DynamoDB-backed {@link DataStore} requires. */
export interface DynamoTableSchema {
  table: string
  /** Base-table partition key (the length-prefixed scope). */
  partitionKey: string
  /** Base-table sort key (the entity id). */
  sortKey: string
  /** The optimistic-concurrency version attribute. */
  versionAttr: string
  /** The soft-delete tombstone attribute (present only on tombstoned items). */
  deletedAtAttr: string
  /** One GSI per declared `@persisted` index field. */
  gsis: DynamoGsiSchema[]
}

/** Base-table attribute names — the DataStore item shape on the wire. */
export const DATA_PK_ATTR = 'pk'
export const DATA_SK_ATTR = 'sk'
export const DATA_VERSION_ATTR = 'version'
export const DATA_DELETED_AT_ATTR = 'deletedAt'

/** The GSI partition-key attribute for a declared index field. */
function gsiPkAttr(field: string): string {
  return `gsi_${field.replace(/[^A-Za-z0-9_]/g, '_')}_pk`
}
/** The GSI index name for a declared index field. */
function gsiName(field: string): string {
  return `gsi_${field.replace(/[^A-Za-z0-9_]/g, '_')}`
}

/**
 * Describe the table + GSIs an IaC template (CDK / CloudFormation / Terraform)
 * must create for a DynamoDB-backed {@link DataStore} — the adapter never issues
 * DDL at runtime (a Lambda shouldn't create tables on the hot path).
 *
 *   - Base table: HASH `pk` (length-prefixed scope) + RANGE `sk` (entity id), so
 *     a `Query` for one scope is one contiguous partition ordered by id, with
 *     native `LastEvaluatedKey` pagination, and cross-scope reads are impossible.
 *   - Each declared `@persisted` index field → a GSI keyed
 *     HASH `gsi_<field>_pk = "<scope>#<value>"` + RANGE `sk`, so a filtered
 *     `list`/`count` Querys that GSI within one scope, ordered by id.
 *
 * NOTE: GSIs are EVENTUALLY CONSISTENT (DynamoDB does not support
 * `ConsistentRead` on a GSI). A filtered `list` served by a GSI may therefore
 * lag a just-committed write by a small interval — acceptable for a list view,
 * but `get`/`update`/`delete` (base-table, `ConsistentRead: true`) are always
 * strongly consistent.
 *
 * @param table the table name (default {@link DDB_DATA_TABLE_DEFAULT}); must
 *   match the `opts.table` passed to {@link createDynamoDataStore} /
 *   {@link createDynamoDataPort}.
 * @param indexes the declared `@persisted` index field names.
 */
export function describeDataTable(
  table: string = DDB_DATA_TABLE_DEFAULT,
  indexes: readonly string[] = [],
): DynamoTableSchema {
  return {
    table,
    partitionKey: DATA_PK_ATTR,
    sortKey: DATA_SK_ATTR,
    versionAttr: DATA_VERSION_ATTR,
    deletedAtAttr: DATA_DELETED_AT_ATTR,
    gsis: indexes.map((field) => ({
      field,
      indexName: gsiName(field),
      partitionKey: gsiPkAttr(field),
      sortKey: DATA_SK_ATTR,
    })),
  }
}

// ---------------------------------------------------------------------------
// Real DynamoDB port — the ONLY place that speaks the DynamoSendLike protocol.
// ---------------------------------------------------------------------------

/**
 * Tag a plain command-input object with which DocumentClient command it is, so a
 * thin shim can construct the real `*Command`. Extends the security port's
 * `toCommand` (Put/Get/Update/Delete) with `Query` for list/count. Kept local so
 * this file imports only {@link DynamoSendLike} (not the security port's helper).
 */
function toCommand(
  kind: 'Put' | 'Get' | 'Delete' | 'Query' | 'Update',
  input: Record<string, unknown>,
): unknown {
  return { __command: kind, ...input }
}

/** True for a DynamoDB `ConditionalCheckFailedException` (any SDK shape). */
function isConditionalCheckFailed(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const name = (err as { name?: unknown }).name
  const code = (err as { __type?: unknown }).__type
  return (
    name === 'ConditionalCheckFailedException' ||
    (typeof code === 'string' && code.includes('ConditionalCheckFailed'))
  )
}

/**
 * Build the REAL {@link DynamoDataPort} over a structural {@link DynamoSendLike}.
 * This is the only DynamoDB command construction in the adapter; the store logic
 * stays command-free. Like the security port, the consumer passes their real
 * `DynamoDBDocumentClient` (recommended — it marshalls native JS values) wrapped
 * in a tiny `DynamoSendLike` that maps the `__command` tag to the matching
 * `*Command` constructor (now including `QueryCommand`); see `dynamoPort.ts` for
 * the wiring example.
 *
 * Versioned writes are conditional: `Put`/`Update` carry
 * `ConditionExpression: '#v = :expected'`, so a `ConditionalCheckFailedException`
 * means the version moved → {@link CONFLICT}. We read the live item first
 * (`ConsistentRead`) to disambiguate miss vs conflict, exactly as the cf D1 port
 * reads before its conditional `UPDATE`. Create is a `Put` on
 * `attribute_not_exists(pk)` (or `attribute_exists(deletedAt)` when resurrecting
 * a tombstone).
 *
 * **Filtered list.** A `filter` on a DECLARED index field Querys that field's GSI
 * (`gsi_<field>_pk = "<scope>#<value>"`), server-side and sargable — DynamoDB
 * reads only the matching items, so it stays cheap at scale. A filter with NO
 * declared index falls back to a base-table partition `Query` (`pk = scope`) that
 * reads the scope's partition and applies the equality AS A CLIENT-SIDE
 * POST-FILTER over the parsed entity JSON. (DynamoDB cannot `FilterExpression`
 * inside the opaque `value` blob, so the entity payload is never matched
 * server-side; only declared-index fields, projected to GSI keys, and the
 * `deletedAt` tombstone are server-side predicates.) The fallback therefore reads
 * the scope partition (read cost is the partition size, not the match count),
 * draining `LastEvaluatedKey` pages until the page is filled. To bound that cost
 * cliff the undeclared-filter scan is CAPPED at {@link SCAN_CAP} items (mirrors
 * adapter-node) with a `console.warn`: `list` stops at the cap and returns the
 * matches found so far WITH a continuation cursor (a partial page that resumes
 * past the last scanned id), and `count` — which must be EXACT — REFUSES an
 * undeclared filter with a thrown error (a capped count would silently lie).
 * DECLARE an index via `@persisted(indexes)` to keep a hot filter sargable, avoid
 * the partition read, and enable an exact server-side count. CAVEAT: a GSI is
 * EVENTUALLY CONSISTENT, so a GSI-served filter may briefly omit a just-committed
 * write (see {@link describeDataTable}).
 *
 * Production wiring: `createDynamoDataPort(sendLike, 'todos', { indexes: ['ownerId'] })`.
 *
 * @param client the consumer's `DynamoDBDocumentClient` (structural).
 * @param tableName the table name; must match {@link createDynamoDataStore}'s `opts.table`.
 * @param opts.indexes the declared `@persisted` index field names (must match the
 *   GSIs created per {@link describeDataTable}).
 */
export function createDynamoDataPort(
  client: DynamoSendLike,
  tableName: string = DDB_DATA_TABLE_DEFAULT,
  opts: { indexes?: readonly string[] } = {},
): DynamoDataPort {
  const indexes = new Set(opts.indexes ?? [])

  /** Build the item written to DynamoDB, including any declared-index GSI keys. */
  const toItem = (scope: string, row: DynamoRow): Record<string, unknown> => {
    const obj = JSON.parse(row.value) as Record<string, unknown>
    const item: Record<string, unknown> = {
      [DATA_PK_ATTR]: scope,
      [DATA_SK_ATTR]: row.id,
      value: row.value,
      [DATA_VERSION_ATTR]: row.version,
    }
    if (row.deletedAt !== null) item[DATA_DELETED_AT_ATTR] = row.deletedAt
    // Project declared index fields into their GSI partition keys. A tombstoned
    // row drops its GSI keys so it leaves the filtered index (extra invisibility).
    for (const field of indexes) {
      if (row.deletedAt === null && obj[field] !== undefined) {
        item[gsiPkAttr(field)] = `${scope}#${String(obj[field])}`
      }
    }
    return item
  }

  const toRow = (it: Record<string, unknown> | null | undefined): DynamoRow | null => {
    if (!it) return null
    const da = it[DATA_DELETED_AT_ATTR]
    return {
      id: String(it[DATA_SK_ATTR]),
      value: String(it.value),
      version: Number(it[DATA_VERSION_ATTR]),
      deletedAt: da === null || da === undefined ? null : String(da),
    }
  }

  const read = async (scope: string, id: string): Promise<DynamoRow | null> => {
    const out = await client.send(
      toCommand('Get', {
        TableName: tableName,
        Key: { [DATA_PK_ATTR]: scope, [DATA_SK_ATTR]: id },
        ConsistentRead: true, // strong consistency for get / CAS disambiguation.
      }),
    )
    return toRow(out.Item)
  }

  /**
   * The entity payload lives in the opaque JSON `value` attribute — DynamoDB
   * cannot match inside it with a `FilterExpression`. So any filter field NOT
   * served by the GSI partition key (the declared `index` value) is applied as a
   * client-side post-filter over the parsed `value`. (Declared-index fields are
   * matched server-side by the GSI partition; this only covers the residual.)
   */
  const residualFilter = (
    filter: Record<string, string | number | boolean> | undefined,
    skip: ReadonlySet<string>,
  ): ((row: DynamoRow) => boolean) | undefined => {
    if (!filter) return undefined
    const fields = Object.entries(filter).filter(([f]) => !skip.has(f))
    if (fields.length === 0) return undefined
    return (row) => {
      const obj = JSON.parse(row.value) as Record<string, unknown>
      for (const [field, want] of fields) {
        if (obj[field] !== want) return false
      }
      return true
    }
  }

  return {
    getRow(scope, id) {
      return read(scope, id)
    },

    async insertIfAbsent(scope, row, allowOverTombstone) {
      // Resurrecting a soft-delete tombstone CONTINUES the version
      // (tombstone.version + 1), it never resets to 1. Read first to learn the
      // tombstone's version; the conditional Put then guards on BOTH the
      // not-live/tombstone condition AND that the version is unchanged, so a
      // racing writer between the read and the Put still trips the condition.
      let version = 1
      let guardVersion: number | undefined
      if (allowOverTombstone) {
        const cur = await read(scope, row.id)
        if (cur && cur.deletedAt !== null) {
          version = cur.version + 1 // continue over the tombstone
          guardVersion = cur.version
        }
      }
      const fresh: DynamoRow = { ...row, version, deletedAt: null }
      const names: Record<string, string> = { '#pk': DATA_PK_ATTR }
      const values: Record<string, unknown> = {}
      let cond: string
      if (allowOverTombstone) {
        // Refuse to overwrite a LIVE item. attribute_not_exists(pk) covers a
        // brand-new key; resurrection accepts an item whose deletedAt exists (a
        // tombstone) AND whose version still matches what we read.
        names['#da'] = DATA_DELETED_AT_ATTR
        if (guardVersion !== undefined) {
          names['#v'] = DATA_VERSION_ATTR
          values[':expected'] = guardVersion
          cond = 'attribute_not_exists(#pk) OR (attribute_exists(#da) AND #v = :expected)'
        } else {
          cond = 'attribute_not_exists(#pk) OR attribute_exists(#da)'
        }
      } else {
        cond = 'attribute_not_exists(#pk)'
      }
      try {
        await client.send(
          toCommand('Put', {
            TableName: tableName,
            Item: toItem(scope, fresh),
            ConditionExpression: cond,
            ExpressionAttributeNames: names,
            ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
          }),
        )
        return version
      } catch (err) {
        if (isConditionalCheckFailed(err)) return null
        throw err
      }
    },

    async putRow(scope, row) {
      // ATOMIC, monotonic upsert: a single UpdateItem that sets the value
      // attributes AND increments the version with DynamoDB's native
      // `if_not_exists(version, 0) + 1` — no read, no retry loop, so two
      // concurrent puts get distinct, increasing versions. Resurrects a tombstone
      // by REMOVEing deletedAt (and its GSI keys are re-projected from the value).
      const obj = JSON.parse(row.value) as Record<string, unknown>
      const names: Record<string, string> = {
        '#val': 'value',
        '#v': DATA_VERSION_ATTR,
        '#da': DATA_DELETED_AT_ATTR,
      }
      const values: Record<string, unknown> = {
        ':val': row.value,
        ':zero': 0,
        ':one': 1,
      }
      const setClauses = ['#val = :val', '#v = if_not_exists(#v, :zero) + :one']
      const removeClauses = ['#da']
      // Re-project declared-index GSI keys from the (now live) value; drop any
      // index attr whose field is absent so a stale GSI key can't linger.
      for (const field of indexes) {
        const gpk = gsiPkAttr(field)
        names[`#g_${field}`] = gpk
        if (obj[field] !== undefined) {
          setClauses.push(`#g_${field} = :g_${field}`)
          values[`:g_${field}`] = `${scope}#${String(obj[field])}`
        } else {
          removeClauses.push(`#g_${field}`)
        }
      }
      const out = await client.send(
        toCommand('Update', {
          TableName: tableName,
          Key: { [DATA_PK_ATTR]: scope, [DATA_SK_ATTR]: row.id },
          UpdateExpression: `SET ${setClauses.join(', ')} REMOVE ${removeClauses.join(', ')}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'UPDATED_NEW',
        }),
      )
      const attrs = (out.Attributes as Record<string, unknown> | undefined) ?? {}
      return Number(attrs[DATA_VERSION_ATTR])
    },

    async updateCas(scope, row, expectedVersion) {
      // Read the live row to disambiguate miss vs conflict (a ConditionalCheck
      // failure alone can't tell them apart). The conditional Put then enforces
      // the CAS atomically — a racing writer still trips ConditionalCheckFailed.
      const cur = await read(scope, row.id)
      if (!cur || cur.deletedAt !== null) return MISS
      const guard = expectedVersion === undefined ? cur.version : expectedVersion
      const next: DynamoRow = { ...row, version: guard + 1, deletedAt: null }
      try {
        await client.send(
          toCommand('Put', {
            TableName: tableName,
            Item: toItem(scope, next),
            ConditionExpression: '#v = :expected AND attribute_not_exists(#da)',
            ExpressionAttributeNames: { '#v': DATA_VERSION_ATTR, '#da': DATA_DELETED_AT_ATTR },
            ExpressionAttributeValues: { ':expected': guard },
          }),
        )
        return guard + 1
      } catch (err) {
        if (isConditionalCheckFailed(err)) {
          // The condition failed AFTER the read. Re-read (ConsistentRead) to
          // disambiguate a concurrent HARD-DELETE (row now absent → MISS, a 404)
          // from a genuine version move (row still live → CONFLICT, a 409). Only
          // a real conflict surfaces as OptimisticConflictError.
          const after = await read(scope, row.id)
          return !after || after.deletedAt !== null ? MISS : CONFLICT
        }
        throw err
      }
    },

    async deleteCas(scope, id, expectedVersion, softDeletePayload) {
      const cur = await read(scope, id)
      if (!cur || cur.deletedAt !== null) return MISS
      if (expectedVersion !== undefined && cur.version !== expectedVersion) return CONFLICT
      const guard = cur.version
      if (softDeletePayload) {
        try {
          await client.send(
            toCommand('Put', {
              TableName: tableName,
              Item: toItem(scope, softDeletePayload),
              ConditionExpression: '#v = :expected AND attribute_not_exists(#da)',
              ExpressionAttributeNames: { '#v': DATA_VERSION_ATTR, '#da': DATA_DELETED_AT_ATTR },
              ExpressionAttributeValues: { ':expected': guard },
            }),
          )
          return guard + 1
        } catch (err) {
          if (isConditionalCheckFailed(err)) {
            // As in updateCas: a soft-delete is a version-guarded conditional Put,
            // so a concurrent HARD-DELETE trips ConditionalCheckFailed. Re-read to
            // tell an absent row (MISS, a 404) from a genuine version move (CONFLICT).
            const after = await read(scope, id)
            return !after || after.deletedAt !== null ? MISS : CONFLICT
          }
          throw err
        }
      }
      try {
        await client.send(
          toCommand('Delete', {
            TableName: tableName,
            Key: { [DATA_PK_ATTR]: scope, [DATA_SK_ATTR]: id },
            ConditionExpression: '#v = :expected',
            ExpressionAttributeNames: { '#v': DATA_VERSION_ATTR },
            ExpressionAttributeValues: { ':expected': guard },
          }),
        )
        return 0
      } catch (err) {
        if (isConditionalCheckFailed(err)) return CONFLICT
        throw err
      }
    },

    async listRows(scope, args) {
      // Route to the GSI only when the declared index ALSO has a filter VALUE to
      // match on. A declared index name with no corresponding filter entry falls
      // to the base-table partition path, where the residual filter triggers the
      // SCAN_CAP guard — otherwise a `{index:'x'}` with no `filter.x` would drain
      // the whole partition uncapped.
      const indexVal =
        args.index !== undefined && indexes.has(args.index)
          ? args.filter?.[args.index]
          : undefined
      const useGsi = indexVal !== undefined
      // The declared-index field is matched server-side by the GSI partition key;
      // every OTHER filter field is matched client-side over the parsed `value`
      // (DynamoDB can't FilterExpression inside the opaque JSON blob).
      const skip = useGsi && indexVal !== undefined ? new Set([args.index!]) : new Set<string>()
      const post = residualFilter(args.filter, skip)

      const exprNames: Record<string, string> = {}
      const exprValues: Record<string, unknown> = {}
      const keyClauses: string[] = []
      if (useGsi && indexVal !== undefined) {
        exprNames['#gpk'] = gsiPkAttr(args.index!)
        exprValues[':gpk'] = `${scope}#${String(indexVal)}`
        keyClauses.push('#gpk = :gpk')
      } else {
        exprNames['#pk'] = DATA_PK_ATTR
        exprValues[':pk'] = scope
        keyClauses.push('#pk = :pk')
      }
      if (args.after !== undefined) {
        // Only declare #sk when the cursor clause actually references it —
        // DynamoDB rejects an ExpressionAttributeNames key unused in any expression.
        exprNames['#sk'] = DATA_SK_ATTR
        exprValues[':after'] = args.after
        keyClauses.push('#sk > :after')
      }

      const filterClauses: string[] = []
      if (args.excludeDeleted) {
        exprNames['#da'] = DATA_DELETED_AT_ATTR
        filterClauses.push('attribute_not_exists(#da)')
      }

      // An undeclared filter resolves CLIENT-SIDE (post): the partition `Query`
      // can drain the whole scope before filling the page. Bound the items SCANNED
      // by SCAN_CAP — stop early and hand back the matches found so far plus the
      // last scanned id, so the store emits a continuation cursor (partial page).
      const capped = post !== undefined && !useGsi
      if (capped) {
        console.warn(
          `[adapter-aws] DataStore.list: filtering on non-declared index ` +
            `${Object.keys(args.filter ?? {}).join(',')} via a capped partition ` +
            `scan (cap=${SCAN_CAP}); declare it in @persisted(indexes) for a GSI.`,
        )
      }

      // Drive Query pages until we have `limit` rows or the partition is drained.
      // (A FilterExpression / client post-filter is applied AFTER the read, so a
      // page may yield fewer than requested — we keep paging on LastEvaluatedKey.)
      const out: DynamoRow[] = []
      let lek: Record<string, unknown> | undefined
      let scanned = 0
      let lastScannedId: string | undefined
      let hitCap = false
      do {
        const res = await client.send(
          toCommand('Query', {
            TableName: tableName,
            ...(useGsi && indexVal !== undefined ? { IndexName: gsiName(args.index!) } : {}),
            KeyConditionExpression: keyClauses.join(' AND '),
            ...(filterClauses.length ? { FilterExpression: filterClauses.join(' AND ') } : {}),
            ExpressionAttributeNames: exprNames,
            ExpressionAttributeValues: exprValues,
            Limit: Math.max(args.limit, 1),
            ...(lek ? { ExclusiveStartKey: lek } : {}),
            ScanIndexForward: true,
          }),
        )
        const items = (res.Items as Record<string, unknown>[] | undefined) ?? []
        for (const it of items) {
          const r = toRow(it)
          if (!r) continue
          lastScannedId = r.id
          if (capped && ++scanned > SCAN_CAP) {
            hitCap = true
            break
          }
          if (post && !post(r)) continue
          out.push(r)
          if (out.length >= args.limit) break
        }
        lek = res.LastEvaluatedKey as Record<string, unknown> | undefined
      } while (lek && out.length < args.limit && !hitCap)

      const rows = out.slice(0, args.limit)
      // Resume past the last scanned id only when the cap stopped us short with the
      // partition not yet drained (more may match beyond the cap).
      const nextAfter = hitCap && out.length < args.limit ? lastScannedId : undefined
      return nextAfter !== undefined ? { rows, nextAfter } : { rows }
    },

    async count(scope, filter, index, excludeDeleted) {
      // Route to the GSI only when the declared index ALSO has a filter VALUE. A
      // declared index name with no filter entry falls to the base-table path,
      // where the residual filter trips the exact-count refusal below — otherwise
      // a `{index:'x'}` with no `filter.x` would silently drain+count the whole
      // partition client-side, bypassing the cap-and-refuse guard.
      const indexVal =
        index !== undefined && indexes.has(index) ? filter?.[index] : undefined
      const useGsi = indexVal !== undefined
      const skip = useGsi && indexVal !== undefined ? new Set([index!]) : new Set<string>()
      const post = residualFilter(filter, skip)

      // `count` must be EXACT, so an undeclared-filter scan can't be silently
      // capped (a capped count would lie). Refuse it loudly — declare the field in
      // @persisted(indexes) so the count runs server-side on the GSI. (A filter
      // fully served by a declared GSI key has no residual `post` and is allowed.)
      if (post !== undefined && !useGsi) {
        throw new Error(
          `[adapter-aws] DataStore.count: an exact count on a non-declared index ` +
            `(${Object.keys(filter ?? {}).join(',')}) would require an uncapped ` +
            `partition scan; declare it in @persisted(indexes) for a server-side ` +
            `GSI count.`,
        )
      }

      const exprNames: Record<string, string> = {}
      const exprValues: Record<string, unknown> = {}
      const keyClauses: string[] = []
      if (useGsi && indexVal !== undefined) {
        exprNames['#gpk'] = gsiPkAttr(index!)
        exprValues[':gpk'] = `${scope}#${String(indexVal)}`
        keyClauses.push('#gpk = :gpk')
      } else {
        exprNames['#pk'] = DATA_PK_ATTR
        exprValues[':pk'] = scope
        keyClauses.push('#pk = :pk')
      }
      const filterClauses: string[] = []
      if (excludeDeleted) {
        exprNames['#da'] = DATA_DELETED_AT_ATTR
        filterClauses.push('attribute_not_exists(#da)')
      }

      // With a client-side residual post-filter, COUNT can't run purely on the
      // server — fetch the matching items and count them. Without a residual
      // filter (no filter, or filter fully served by the GSI key) use the cheap
      // server-side `Select: 'COUNT'`.
      let total = 0
      let lek: Record<string, unknown> | undefined
      do {
        const res = await client.send(
          toCommand('Query', {
            TableName: tableName,
            ...(useGsi && indexVal !== undefined ? { IndexName: gsiName(index!) } : {}),
            KeyConditionExpression: keyClauses.join(' AND '),
            ...(filterClauses.length ? { FilterExpression: filterClauses.join(' AND ') } : {}),
            ExpressionAttributeNames: exprNames,
            ExpressionAttributeValues: exprValues,
            ...(post ? {} : { Select: 'COUNT' }),
            ...(lek ? { ExclusiveStartKey: lek } : {}),
          }),
        )
        if (post) {
          const items = (res.Items as Record<string, unknown>[] | undefined) ?? []
          for (const it of items) {
            const r = toRow(it)
            if (r && post(r)) total++
          }
        } else {
          total += Number(res.Count ?? 0)
        }
        lek = res.LastEvaluatedKey as Record<string, unknown> | undefined
      } while (lek)
      return total
    },
  }
}

// ---------------------------------------------------------------------------
// Fake DynamoDB port — in-process Map, reimplements the semantics (no commands).
// ---------------------------------------------------------------------------

/**
 * An in-process {@link DynamoDataPort} backed by a `Map`. Reimplements the CAS /
 * create-if-absent / filtered-list semantics in JS — exactly as adapter-cf's
 * `createFakeD1DataPort` reimplements the SQL CAS — so the always-on conformance
 * suite exercises all store logic with no DynamoDB. The real command protocol is
 * validated by `live.dynamodb.dataStore.test.ts` in CI.
 *
 * Each call runs its read-compare-write in one synchronous section before the
 * returned promise settles, so there is no interleaving (JS single-thread) — the
 * same atomicity a DynamoDB conditional write gives per item.
 */
export function createFakeDynamoDataPort(): DynamoDataPort {
  /** `${scope} ${id}` → row. */
  const rows = new Map<string, DynamoRow>()
  const k = (scope: string, id: string): string => `${scope} ${id}`

  const liveMatches = (
    row: DynamoRow,
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
      const overTombstone = !!(cur && allowOverTombstone && cur.deletedAt !== null)
      if (cur && !overTombstone) return null
      // Resurrecting a tombstone CONTINUES the version (tombstone.version + 1);
      // a brand-new key (or create after a HARD delete = no row) gets version 1.
      const version = overTombstone ? cur!.version + 1 : 1
      rows.set(k(scope, row.id), { ...row, version, deletedAt: null })
      return version
    },

    async putRow(scope, row) {
      // Atomic, monotonic: continue from the stored version (live OR tombstone),
      // so a put over a tombstone continues rather than resetting to 1.
      const cur = rows.get(k(scope, row.id))
      const newVersion = (cur?.version ?? 0) + 1
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
      // Mirror the real port: an undeclared filter (a filter present but NOT
      // served by a declared index) is a capped client-side scan over the scope.
      const undeclared = args.filter !== undefined && args.index === undefined
      const all: DynamoRow[] = []
      for (const [key, row] of rows) {
        if (key.startsWith(`${scope} `)) all.push(row)
      }
      all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      const out: DynamoRow[] = []
      let scanned = 0
      let lastScannedId: string | undefined
      let hitCap = false
      for (const row of all) {
        if (args.after !== undefined && !(row.id > args.after)) continue
        lastScannedId = row.id
        if (undeclared && ++scanned > SCAN_CAP) {
          hitCap = true
          break
        }
        if (!liveMatches(row, scope, args.filter, args.excludeDeleted, args.after, k(scope, row.id)))
          continue
        out.push(row)
        if (out.length >= args.limit) break
      }
      const rowsOut = out.slice(0, args.limit)
      const nextAfter = hitCap && out.length < args.limit ? lastScannedId : undefined
      return nextAfter !== undefined ? { rows: rowsOut, nextAfter } : { rows: rowsOut }
    },

    async count(scope, filter, index, excludeDeleted) {
      // Mirror the real port: an exact count over a non-declared filter would need
      // an uncapped scan — refuse it (a declared filter has `index` set).
      if (filter !== undefined && index === undefined) {
        throw new Error(
          `[adapter-aws] DataStore.count: an exact count on a non-declared index ` +
            `(${Object.keys(filter).join(',')}) would require an uncapped scan; ` +
            `declare it in @persisted(indexes) for a server-side GSI count.`,
        )
      }
      let n = 0
      for (const [key, row] of rows) {
        if (liveMatches(row, scope, filter, excludeDeleted, undefined, key)) n++
      }
      return n
    },
  }
}

// ---------------------------------------------------------------------------
// Factory.
// ---------------------------------------------------------------------------

/**
 * Construct a DynamoDB-backed {@link DataStore} over a {@link DynamoDataPort}.
 * Like the security stores, the logic lives only against the port, so the same
 * class passes the `@smithy-hono/data-core` conformance suite against the
 * in-process fake AND runs unchanged against real DynamoDB in production.
 *
 * Full capabilities: optimistic concurrency (conditional-write CAS), equality
 * filter + count (GSI `Query` for declared indexes, partition `Query` +
 * `FilterExpression` otherwise), opaque-cursor pagination (`LastEvaluatedKey`),
 * and (opt-in) soft-delete.
 *
 * @example
 *   const store = createDynamoDataStore(
 *     createDynamoDataPort(sendLike, 'todos', { indexes: ['ownerId'] }),
 *     { table: 'todos', indexes: ['ownerId'], softDelete: false },
 *   )
 */
export function createDynamoDataStore<
  T extends Record<string, unknown> = Record<string, unknown>,
>(port: DynamoDataPort, opts: DynamoDataStoreOptions = {}): DataStore<T> {
  return new DynamoDataStore<T>(port, opts)
}

export { DynamoDataStore }
