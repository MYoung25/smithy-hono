/**
 * The `DataStore<T>` persistence port (Plan 13 — default DB-backed CRUD).
 *
 * A single pluggable port behind the codegen'd default CRUD impl. It mirrors the
 * `security-core/storage` pattern (structural port → memory impl → conformance
 * suite → per-adapter real impl) but covers a **different concern**: generic
 * entity persistence, not security state. (security-core/storage's documented
 * contract is "security concerns only" — keep these separate.)
 *
 * Design seams that must NOT be foreclosed (or the full design becomes a
 * breaking migration):
 *  - `version` lives in the {@link Stored} envelope **from day one** (the memory
 *    impl may ignore conflicts when optimistic concurrency is off, but the field
 *    always exists — DynamoDB already requires it).
 *  - {@link DataScope} is a **parameter on every method**, never a closure/filter
 *    (it can't be retrofitted into a partition key later).
 *  - {@link Page} returns an **opaque `cursor`**, never an offset.
 *
 * Web-standard only (ARCH-01): no `node:*`, no `@types/node`. Concrete DB-backed
 * implementations (Redis / DynamoDB / D1 / KV) live in the adapter packages,
 * behind their existing narrow structural ports — no SDK imports here.
 */

// ---------------------------------------------------------------------------
// Scope — tenancy / ownership partitioning, threaded into every method.
// ---------------------------------------------------------------------------

/**
 * The partition a store operation runs within. Both fields are optional:
 * single-tenant / unscoped apps leave them unset and the store ignores scope.
 * When set, scope is part of the **effective key/partition** — tenant A's keys
 * are invisible to tenant B (cross-tenant reads return `null`, never another
 * tenant's row). Auto-injected from the principal by the generated `scopeFrom`.
 */
export interface DataScope {
  tenantId?: string
  ownerId?: string
}

// ---------------------------------------------------------------------------
// Stored envelope — the entity plus store-managed metadata.
// ---------------------------------------------------------------------------

/**
 * An entity as it lives in the store: the caller's `T` plus a store-managed
 * envelope. `version` is the optimistic-concurrency token (incremented on every
 * write); `deletedAt` is the soft-delete tombstone (present only when the
 * resource is configured for `softDelete`).
 */
export type Stored<T> = T & {
  /** Optimistic-concurrency token, store-managed (incremented on each write). */
  readonly version: number
  /** Tombstone timestamp (ISO-8601) — present only when softDelete is enabled. */
  readonly deletedAt?: string
}

// ---------------------------------------------------------------------------
// Listing — opaque-cursor pagination + capability-graded equality filter.
// ---------------------------------------------------------------------------

/**
 * A page request. `cursor` is an **opaque** continuation token returned by a
 * prior {@link Page} — NEVER an offset the caller can fabricate. `filter` is
 * equality-only and capability-graded (backends that can't filter skip it).
 */
export interface ListQuery {
  /**
   * Maximum rows to return. **Must be `>= 1`**; a non-positive limit (0 or
   * negative) is a caller error and stores throw `RangeError` rather than
   * silently returning nothing (which would make data unreachable).
   *
   * This is an UPPER bound the caller requests, not a guarantee: a store MAY be
   * configured with a `maxLimit` and will then silently CLAMP the effective page
   * size down to it (`Math.min(limit, maxLimit)`) as defense-in-depth against an
   * unbounded scan. The clamp only lowers how many rows a page returns; the
   * opaque resume-`cursor` contract is preserved, so the caller still pages
   * through the full result set. A store with no `maxLimit` configured honors
   * `limit` exactly.
   */
  limit: number
  /** Opaque continuation token from a prior page — NEVER an offset. */
  cursor?: string
  /** Equality-only predicate; capability-graded per backend. */
  filter?: Record<string, string | number | boolean>
  /** A declared `@persisted` index to filter against, when filtering. */
  index?: string
}

/** A page of results plus an opaque continuation `cursor` (absent on last page). */
export interface Page<T> {
  items: Stored<T>[]
  cursor?: string
}

// ---------------------------------------------------------------------------
// DataStore — the port.
// ---------------------------------------------------------------------------

/**
 * The pluggable persistence port behind default CRUD. All methods are async
 * (backends are network-bound), string-keyed, and take an explicit
 * {@link DataScope}. Concurrency is expressed as a method contract (the
 * codebase's style), not a generic CAS primitive.
 */
export interface DataStore<T = Record<string, unknown>> {
  /** Resolve an entity by key within `scope`, or `null` if absent (or cross-scope). */
  get(key: string, scope: DataScope): Promise<Stored<T> | null>

  /** Create at `key`; **fails if a (live) entity already exists** there. */
  create(key: string, value: T, scope: DataScope): Promise<Stored<T>>

  /** Unconditional upsert at `key` (idempotent create-at-id / replace). */
  put(key: string, value: T, scope: DataScope): Promise<Stored<T>>

  /**
   * Full replace at `key`. If `expectedVersion` is provided and does not match
   * the stored version, throws {@link OptimisticConflictError}.
   */
  update(
    key: string,
    value: T,
    expectedVersion: number | undefined,
    scope: DataScope,
  ): Promise<Stored<T>>

  /**
   * Merge `partial` into the stored entity at `key`. If `expectedVersion` is
   * provided and does not match, throws {@link OptimisticConflictError}.
   */
  patch(
    key: string,
    partial: Partial<T>,
    expectedVersion: number | undefined,
    scope: DataScope,
  ): Promise<Stored<T>>

  /**
   * Delete the entity at `key`. Returns `true` if something was deleted, `false`
   * if it was absent. If `expectedVersion` is provided and does not match,
   * throws {@link OptimisticConflictError}.
   */
  delete(
    key: string,
    expectedVersion: number | undefined,
    scope: DataScope,
  ): Promise<boolean>

  /** List entities within `scope`, paginated by an opaque cursor. */
  list(query: ListQuery, scope: DataScope): Promise<Page<T>>

  /** Optional: count matching entities (capability-graded). */
  count?(
    query: Omit<ListQuery, 'cursor' | 'limit'>,
    scope: DataScope,
  ): Promise<number>
}

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

/**
 * Thrown by version-guarded writes when `expectedVersion` does not match the
 * stored version. The CrudEmitter re-throws this as the resource's modeled 409.
 */
export class OptimisticConflictError extends Error {
  constructor(message = 'Optimistic concurrency conflict: version mismatch') {
    super(message)
    this.name = 'OptimisticConflictError'
  }
}
