/**
 * In-memory dev/test implementation of {@link DataStore} (Plan 13).
 *
 * ⚠️  DEV / SINGLE-PROCESS ONLY (ARCH-02). State lives in a plain `Map` in the
 * current process; it is **meaningless on Workers isolates / Lambda containers**
 * (each has its own copy — no cross-request consistency). It exists so
 * `examples/crud-api` and unit tests can run zero-handler CRUD without an
 * external backend. Production uses the adapter packages (Redis / DynamoDB /
 * D1 / KV) behind their structural ports.
 *
 * Within a single process it is correct and (because JS runs each async body to
 * completion without interleaving its synchronous sections) strongly consistent,
 * which is what lets it pass the shared conformance suite.
 *
 * Web-standard only (ARCH-01): `crypto.randomUUID`, no `node:*`.
 *
 * Ownership: the store owns its data. Writes store a **shallow copy** of the
 * caller's value and reads return a **shallow copy** of the stored envelope, so
 * a caller mutating a returned entity (e.g. `(await get(...)).version = 9`)
 * can't corrupt the store. NOTE: shallow only — nested objects/arrays are still
 * shared by reference; that's enough for the version/top-level-field hazard.
 */

import {
  OptimisticConflictError,
  type DataScope,
  type DataStore,
  type ListQuery,
  type Page,
  type Stored,
} from './index.js'

// ---------------------------------------------------------------------------
// Scoping — the DataScope becomes part of the effective key/partition.
// ---------------------------------------------------------------------------

/**
 * Derive the partition prefix from a {@link DataScope}. Tenant/owner become part
 * of the effective key, so tenant A literally cannot address tenant B's rows —
 * a cross-scope `get` resolves a different key and returns `null` (existence
 * hiding). Components are length-prefixed so they can't collide by concatenation.
 */
function scopeKey(scope: DataScope, key: string): string {
  const t = scope.tenantId ?? ''
  const o = scope.ownerId ?? ''
  return `${t.length}:${t}|${o.length}:${o}|${key}`
}

/** The partition prefix alone (for scoped list scans). */
function scopePrefix(scope: DataScope): string {
  const t = scope.tenantId ?? ''
  const o = scope.ownerId ?? ''
  return `${t.length}:${t}|${o.length}:${o}|`
}

/**
 * Strip the store-managed envelope fields (`version`, `deletedAt`) from a caller
 * payload before it is stored. Both are store-owned per the {@link Stored}
 * contract: `version` is re-stamped on every write and `deletedAt` is set ONLY by
 * `delete` under soft-delete. Without this, a caller could inject a `deletedAt`
 * to forge a tombstone (a live row instantly invisible to get/list/count and a
 * permanent zombie occupying the key). See adapter-postgres, which drops these in
 * its `#strip` and keeps `deleted_at` in a dedicated column.
 */
function stripReserved<T>(value: T): T {
  const { version: _v, deletedAt: _d, ...rest } = value as Record<string, unknown>
  return rest as T
}

// ---------------------------------------------------------------------------
// Cursor — opaque base64 of an internal position. NEVER an offset.
// ---------------------------------------------------------------------------

/**
 * The cursor encodes the **last key emitted**, not an offset, so it stays stable
 * under concurrent insert/delete and is never a fabricate-able index. base64 of
 * the bare key is enough for the in-memory store; real adapters use their native
 * continuation token. Web-standard `btoa`/`atob` (ARCH-01).
 */
function encodeCursor(lastKey: string): string {
  return btoa(unescape(encodeURIComponent(lastKey)))
}

function decodeCursor(cursor: string): string {
  return decodeURIComponent(escape(atob(cursor)))
}

// ---------------------------------------------------------------------------
// MemoryDataStore
// ---------------------------------------------------------------------------

interface MemoryDataStoreOptions {
  /**
   * Tombstone on delete instead of hard-removing, and hide tombstoned rows from
   * `get`/`list` (default `false`). Mirrors `@persisted(softDelete:)`.
   */
  softDelete?: boolean
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

class MemoryDataStore<T extends Record<string, unknown>> implements DataStore<T> {
  /** effective-key → stored envelope. */
  private readonly map = new Map<string, Stored<T>>()
  private readonly softDelete: boolean
  private readonly maxLimit: number | undefined

  constructor(opts: MemoryDataStoreOptions = {}) {
    this.softDelete = opts.softDelete ?? false
    this.maxLimit = opts.maxLimit
  }

  async get(key: string, scope: DataScope): Promise<Stored<T> | null> {
    const stored = this.map.get(scopeKey(scope, key))
    if (!stored) return null
    if (stored.deletedAt !== undefined) return null // tombstone is invisible
    return { ...stored } // isolated copy — caller can't mutate the store
  }

  async create(key: string, value: T, scope: DataScope): Promise<Stored<T>> {
    const ek = scopeKey(scope, key)
    const existing = this.map.get(ek)
    if (existing && existing.deletedAt === undefined) {
      throw new Error(`Entity already exists at key '${key}'`)
    }
    // Version is monotonic per key for as long as ANY record exists (live or
    // tombstone): resurrecting a soft-delete tombstone CONTINUES the chain
    // (tombstone.version + 1) — ABA-safe — and only resets to 1 when no record
    // exists at all (first-ever create, or create after a hard delete).
    const nextVersion = existing ? existing.version + 1 : 1
    // Store a copy so a later caller-side mutation of `value` can't reach in, and
    // strip store-managed fields so a caller can't inject version/deletedAt.
    const stored = { ...stripReserved(value), version: nextVersion } as Stored<T>
    this.map.set(ek, stored)
    return { ...stored }
  }

  async put(key: string, value: T, scope: DataScope): Promise<Stored<T>> {
    const ek = scopeKey(scope, key)
    const existing = this.map.get(ek)
    // Version is monotonic per key for as long as ANY record exists (live or
    // tombstone): a put over a soft-delete tombstone CONTINUES the chain
    // (tombstone.version + 1) — ABA-safe — and only resets to 1 when no record
    // exists at all (first-ever put, or put after a hard delete).
    const nextVersion = existing ? existing.version + 1 : 1
    const stored = { ...stripReserved(value), version: nextVersion } as Stored<T>
    this.map.set(ek, stored)
    return { ...stored }
  }

  async update(
    key: string,
    value: T,
    expectedVersion: number | undefined,
    scope: DataScope,
  ): Promise<Stored<T>> {
    const ek = scopeKey(scope, key)
    const existing = this.map.get(ek)
    if (!existing || existing.deletedAt !== undefined) {
      throw new Error(`Entity not found at key '${key}'`)
    }
    this.assertVersion(existing, expectedVersion)
    const stored = { ...stripReserved(value), version: existing.version + 1 } as Stored<T>
    this.map.set(ek, stored)
    return { ...stored }
  }

  async patch(
    key: string,
    partial: Partial<T>,
    expectedVersion: number | undefined,
    scope: DataScope,
  ): Promise<Stored<T>> {
    const ek = scopeKey(scope, key)
    const existing = this.map.get(ek)
    if (!existing || existing.deletedAt !== undefined) {
      throw new Error(`Entity not found at key '${key}'`)
    }
    this.assertVersion(existing, expectedVersion)
    // Merge, then re-stamp the envelope so the version is store-managed. Strip
    // store-managed fields from the incoming partial too, so a caller can't smuggle
    // a `deletedAt` (or `version`) through the merge and forge a tombstone.
    const { version: _v, deletedAt: _d, ...current } = existing
    const merged = { ...current, ...stripReserved(partial) } as unknown as T
    const stored = { ...merged, version: existing.version + 1 } as Stored<T>
    this.map.set(ek, stored)
    return { ...stored }
  }

  async delete(
    key: string,
    expectedVersion: number | undefined,
    scope: DataScope,
  ): Promise<boolean> {
    const ek = scopeKey(scope, key)
    const existing = this.map.get(ek)
    if (!existing || existing.deletedAt !== undefined) return false
    this.assertVersion(existing, expectedVersion)
    if (this.softDelete) {
      // The tombstone RETAINS the live version (no bump). Version is monotonic
      // per key across the tombstone: the next create/put that resurrects this
      // key continues from `tombstone.version + 1` (ABA-safe). Bumping here too
      // would double-count the soft-delete as a write.
      const tombstoned = {
        ...existing,
        deletedAt: new Date().toISOString(),
      } as Stored<T>
      this.map.set(ek, tombstoned)
    } else {
      this.map.delete(ek)
    }
    return true
  }

  async list(query: ListQuery, scope: DataScope): Promise<Page<T>> {
    // Fail fast on a non-positive limit (0 or negative): a `limit: 0` would
    // silently make every row unreachable. The contract is `limit >= 1`.
    if (query.limit < 1) {
      throw new RangeError('list limit must be >= 1')
    }
    // Optional defense-in-depth clamp: lower the effective page size to maxLimit
    // when configured. Unset = no clamp = identical to the prior behavior.
    const effectiveLimit =
      this.maxLimit !== undefined ? Math.min(query.limit, this.maxLimit) : query.limit
    const prefix = scopePrefix(scope)
    // Deterministic order by effective key so the opaque cursor is stable.
    const keys = Array.from(this.map.keys())
      .filter((k) => k.startsWith(prefix))
      .sort()

    const after = query.cursor ? decodeCursor(query.cursor) : undefined
    const items: Stored<T>[] = []
    let lastKey: string | undefined

    for (const ek of keys) {
      // Keys are sorted, so resume by skipping everything at or before the
      // cursor anchor. Strict lexical `>` is robust even if the anchor row was
      // deleted between pages (an `ek === after` check would never re-sync and
      // would silently drop every remaining row).
      if (after !== undefined && ek <= after) continue
      const stored = this.map.get(ek)!
      if (stored.deletedAt !== undefined) continue // tombstones invisible
      if (!matchesFilter(stored, query.filter)) continue
      if (items.length >= effectiveLimit) {
        // There is at least one more matching row → emit a cursor.
        return { items, cursor: lastKey ? encodeCursor(lastKey) : undefined }
      }
      items.push({ ...stored }) // isolated copy — caller can't mutate the store
      lastKey = ek
    }
    return { items }
  }

  async count(
    query: Omit<ListQuery, 'cursor' | 'limit'>,
    scope: DataScope,
  ): Promise<number> {
    const prefix = scopePrefix(scope)
    let n = 0
    for (const [ek, stored] of this.map) {
      if (!ek.startsWith(prefix)) continue
      if (stored.deletedAt !== undefined) continue
      if (!matchesFilter(stored, query.filter)) continue
      n++
    }
    return n
  }

  private assertVersion(
    existing: Stored<T>,
    expectedVersion: number | undefined,
  ): void {
    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw new OptimisticConflictError(
        `Version mismatch: expected ${expectedVersion}, found ${existing.version}`,
      )
    }
  }
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

/**
 * Construct a dev/test in-memory {@link DataStore}. Single-process only
 * (ARCH-02). Pass `{ softDelete: true }` to tombstone on delete and hide
 * tombstoned rows. Pass `{ maxLimit }` to silently clamp a `list`'s effective
 * page size (defense-in-depth; unset = no clamp).
 */
export function createMemoryDataStore<T extends Record<string, unknown> = Record<string, unknown>>(
  opts: MemoryDataStoreOptions = {},
): DataStore<T> {
  return new MemoryDataStore<T>(opts)
}

export type { MemoryDataStoreOptions }
