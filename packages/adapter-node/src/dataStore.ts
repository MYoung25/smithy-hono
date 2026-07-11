/**
 * `DataStore<T>` (Plan 13 — default DB-backed CRUD) over Redis, behind a narrow
 * structural port (ARCH-01).
 *
 * NOT the durable default (Plan 13 D7). For a durable store of record, use
 * `@smithy-hono/adapter-postgres` (Postgres) — it is the **recommended** durable
 * persistence backend for the Node deployment: server-of-record durability and
 * rich list/filter/count via JSONB (`WHERE value->>'field'`, server-side, no
 * scan). This Redis `DataStore` is the optional **cache-grade** alternative — for
 * ephemeral/cache-like entities, or shops already running Redis. It is RAM-bound,
 * and its rich-query support is weaker: filtered list uses hand-maintained
 * declared-index SETs, and any undeclared filter degrades to a capped client-side
 * scan (see {@link SCAN_CAP}). (The *security* stores in this package are
 * unaffected — Redis remains correct there; that is a separate concern.)
 *
 * Like the four security stores, this maps the `@smithy-hono/data-core`
 * {@link DataStore} contract onto a minimal {@link RedisDataPort} — never an
 * `ioredis` / `node-redis` import. Two ports satisfy it:
 *
 *   - {@link createRedisDataPort} — the REAL port, mapping each op onto an
 *     ioredis-style client ({@link RedisDataClientLike}); the consumer injects
 *     their client (the package publishes WITHOUT the SDK).
 *   - {@link createFakeRedisDataPort} — an in-process port over `Map`s that
 *     honors the SAME atomicity contract synchronously (single JS tick == atomic,
 *     like the security-core memory stores). It backs the unit conformance suite.
 *
 * Storage model (one entity = one Redis hash):
 *   - key  `<prefix><scope>|<id>`  → hash with fields `v` (the JSON entity) and
 *     `ver` (the optimistic-concurrency version). `deletedAt` lives inside the
 *     entity JSON when softDelete tombstones.
 *   - The scope ({@link DataScope}) is length-prefixed into the key, so tenant A
 *     literally cannot address tenant B's rows (cross-scope `get` → null).
 *   - A per-scope index SET `<prefix>idx:<scope>` holds every live entity key so
 *     `list` enumerates a scope without a keyspace `SCAN` (and stays scoped).
 *   - Declared `@persisted` indexes get a SET per (index,value):
 *     `<prefix>fidx:<scope>|<index>=<value>` for membership-based filtered list.
 *
 * Versioned writes (create / update / patch / delete CAS) run as a single
 * server-side Lua `EVAL` so the read-compare-write is atomic against real Redis
 * (no WATCH/MULTI retry loop needed) — the fake runs the equivalent JS in one
 * synchronous section. Stale `expectedVersion` → {@link OptimisticConflictError}.
 *
 * Arbitrary (non-declared-index) equality filters fall back to a capped
 * client-side scan with a `console.warn` (see {@link SCAN_CAP}).
 */

import {
  OptimisticConflictError,
  type DataScope,
  type DataStore,
  type ListQuery,
  type Page,
  type Stored,
} from '@smithy-hono/data-core'

/** Minimal structural console (no @types/node; ambient via DOM lib). */
interface ConsoleLike {
  warn(line: string): void
}
declare const console: ConsoleLike

// ---------------------------------------------------------------------------
// RedisDataPort — the only Redis surface the DataStore depends on.
// ---------------------------------------------------------------------------

/**
 * The minimal Redis surface {@link RedisDataStore} uses. Implementations MUST
 * preserve the atomicity of {@link evalCas} (the versioned read-compare-write).
 */
export interface RedisDataPort {
  /** `HGET key field` → value or `null`. */
  hget(key: string, field: string): Promise<string | null>
  /** `SMEMBERS key` → the set members (any order). */
  smembers(key: string): Promise<string[]>
  /**
   * Atomically evaluate the versioned-write Lua script. `argv` carries the
   * operation discriminant and its operands (see {@link CAS_LUA}); the reply is
   * the new version on success, `-1` on a not-found miss, or `-2` on a version
   * conflict. `keys` is `[entityKey, scopeIndexKey, ...filterIndexKeys]`.
   */
  evalCas(keys: string[], argv: (string | number)[]): Promise<number>
}

// ---------------------------------------------------------------------------
// RedisDataClientLike — the ioredis-style client the consumer supplies.
// ---------------------------------------------------------------------------

/**
 * The structural client {@link createRedisDataPort} maps onto. An `ioredis`
 * client satisfies this as-is. Commands used: `HGET`, `SMEMBERS`, `EVAL`.
 */
export interface RedisDataClientLike {
  hget(key: string, field: string): Promise<string | null>
  smembers(key: string): Promise<string[]>
  /** ioredis `EVAL`: `eval(script, numKeys, ...keysThenArgs)`. */
  eval(
    script: string,
    numKeys: number,
    ...keysAndArgs: (string | number)[]
  ): Promise<unknown>
}

// ---------------------------------------------------------------------------
// The versioned-write Lua script (mirrored by the fake's JS).
// ---------------------------------------------------------------------------

/**
 * One atomic read-compare-write for every mutating op. KEYS[1] = entity hash,
 * KEYS[2] = scope-index SET, KEYS[3..] = filter-index SETs (add on write).
 * ARGV[1] = op ('create'|'put'|'update'|'patch'|'delete'),
 * ARGV[2] = expectedVersion (-1 = none), ARGV[3] = entity JSON (writes),
 * ARGV[4] = soft-delete flag ('1'|'0'), ARGV[5] = scope-index-prefix for the
 * filter-index keys (`<prefix>fidx:<scope>|`), ARGV[6..] = declared index field
 * names. The script decodes the CURRENT entity JSON to compute its PRIOR
 * filter-index keys and SREMs them before SADDing the new KEYS[3..], so a changed
 * indexed value never leaves the row in a stale filter-index SET. Reply: new
 * version, or -1 (miss) / -2 (conflict) / 0 (delete miss).
 */
const CAS_LUA = `
local entity = KEYS[1]
local scopeIdx = KEYS[2]
local op = ARGV[1]
local expected = tonumber(ARGV[2])
local payload = ARGV[3]
local soft = ARGV[4]
local fidxPrefix = ARGV[5]
-- HGET returns Lua boolean false on a missing key/field; tonumber(false) is nil,
-- so existence MUST be tested on the raw reply, not the numeric version.
local rawVer = redis.call('HGET', entity, 'ver')
local exists = rawVer ~= false
local curVer = tonumber(rawVer)
local curJson = redis.call('HGET', entity, 'v')
-- A soft-deleted row carries a "deletedAt" tombstone in its JSON; treat it as
-- absent for create/exists checks so create-over-tombstone is allowed.
local tombstoned = soft == '1' and curJson ~= false and string.find(curJson, '"deletedAt":"', 1, true) ~= nil

-- Compute the PRIOR filter-index SET keys from the currently-stored JSON so a
-- changed indexed value (or a soft-delete) can be removed from its old SETs.
-- ARGV[6..] are the declared index field names; only string/number/boolean
-- values produce a key, mirroring #indexKeysFor in TS.
local function oldFilterKeys()
  local keys = {}
  if curJson == false then return keys end
  local ok, obj = pcall(cjson.decode, curJson)
  if not ok or type(obj) ~= 'table' then return keys end
  for i = 6, #ARGV do
    local field = ARGV[i]
    local v = obj[field]
    local t = type(v)
    if t == 'string' or t == 'number' or t == 'boolean' then
      local s = v
      if t == 'boolean' then s = v and 'true' or 'false' end
      keys[#keys + 1] = fidxPrefix .. field .. '=' .. tostring(s)
    end
  end
  return keys
end

local function reindex()
  for _, k in ipairs(oldFilterKeys()) do redis.call('SREM', k, entity) end
  for i = 3, #KEYS do redis.call('SADD', KEYS[i], entity) end
end

if op == 'create' then
  if exists and not tombstoned then return -2 end
  -- Resurrecting a soft-delete tombstone CONTINUES the version (curVer + 1);
  -- a first-ever create (or create after a HARD delete) starts at 1.
  local newVer = 1
  if tombstoned then newVer = curVer + 1 end
  reindex()
  redis.call('HSET', entity, 'v', payload, 'ver', newVer)
  redis.call('SADD', scopeIdx, entity)
  return newVer
end

if op == 'put' then
  local newVer = 1
  if exists then newVer = curVer + 1 end
  reindex()
  redis.call('HSET', entity, 'v', payload, 'ver', newVer)
  redis.call('SADD', scopeIdx, entity)
  return newVer
end

if not exists or tombstoned then return -1 end
if expected >= 0 and curVer ~= expected then return -2 end

if op == 'update' or op == 'patch' then
  local newVer = curVer + 1
  reindex()
  redis.call('HSET', entity, 'v', payload, 'ver', newVer)
  redis.call('SADD', scopeIdx, entity)
  return newVer
end

if op == 'delete' then
  if soft == '1' then
    -- Tombstone the hash, but drop the row from the scope + filter indexes so a
    -- soft-deleted entity stops consuming SCAN budget and stops matching filters.
    for _, k in ipairs(oldFilterKeys()) do redis.call('SREM', k, entity) end
    local newVer = curVer + 1
    redis.call('HSET', entity, 'v', payload, 'ver', newVer)
    redis.call('SREM', scopeIdx, entity)
    return newVer
  end
  redis.call('DEL', entity)
  redis.call('SREM', scopeIdx, entity)
  for _, k in ipairs(oldFilterKeys()) do redis.call('SREM', k, entity) end
  return curVer
end

return -1
`

/** Reply sentinels from {@link CAS_LUA}. */
const MISS = -1
const CONFLICT = -2

// ---------------------------------------------------------------------------
// Keys + cursor.
// ---------------------------------------------------------------------------

/** Length-prefixed scope segment (collision-proof, mirrors the memory store). */
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

// ---------------------------------------------------------------------------
// RedisDataStore
// ---------------------------------------------------------------------------

/** Options for {@link createRedisDataStore} / {@link RedisDataStore}. */
export interface RedisDataStoreOptions {
  /** Key prefix namespacing this collection within a Redis db. Default `'ds:'`. */
  prefix?: string
  /**
   * Tombstone on delete instead of hard-removing, and hide tombstoned rows from
   * `get`/`list` (default `false`). Mirrors `@persisted(softDelete:)`.
   */
  softDelete?: boolean
  /**
   * Declared `@persisted` index field names. A filtered `list` on one of these
   * uses a membership-based index SET (O(matches)); a filter on any other field
   * falls back to a capped, warned client-side scan.
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

/** Cap for the client-side fallback scan over non-indexed filters. */
const SCAN_CAP = 10_000

class RedisDataStore<T extends Record<string, unknown>>
  implements DataStore<T>
{
  readonly #port: RedisDataPort
  readonly #prefix: string
  readonly #softDelete: boolean
  readonly #indexes: ReadonlySet<string>
  readonly #maxLimit: number | undefined

  constructor(port: RedisDataPort, opts: RedisDataStoreOptions = {}) {
    this.#port = port
    this.#prefix = opts.prefix ?? 'ds:'
    this.#softDelete = opts.softDelete ?? false
    this.#indexes = new Set(opts.indexes ?? [])
    this.#maxLimit = opts.maxLimit
  }

  /** Entity hash key. */
  #key(scope: DataScope, id: string): string {
    return `${this.#prefix}${scopeSeg(scope)}|${id}`
  }

  /** Per-scope index SET of every live entity key (for scoped enumeration). */
  #scopeIdx(scope: DataScope): string {
    return `${this.#prefix}idx:${scopeSeg(scope)}`
  }

  /** Declared-index SET for one (field,value) within a scope. */
  #filterIdx(scope: DataScope, field: string, value: string | number | boolean): string {
    return `${this.#filterIdxPrefix(scope)}${field}=${String(value)}`
  }

  /**
   * Common prefix of every filter-index SET key in a scope (`<field>=<value>`
   * appended). Passed to {@link CAS_LUA} (ARGV[5]) so the script can rebuild an
   * entity's PRIOR filter-index keys from its currently-stored JSON.
   */
  #filterIdxPrefix(scope: DataScope): string {
    return `${this.#prefix}fidx:${scopeSeg(scope)}|`
  }

  /**
   * The CAS-tail ARGV shared by every mutating op: the filter-index key prefix
   * (ARGV[5]) followed by the declared index field names (ARGV[6..]). Lets the Lua
   * (and the fake) SREM an entity from its OLD filter-index SETs before SADDing
   * the new ones — preventing a stale index when an indexed value changes.
   */
  #indexArgvTail(scope: DataScope): (string | number)[] {
    return [this.#filterIdxPrefix(scope), ...this.#indexes]
  }

  /** The filter-index SET keys to maintain for an entity, given its values. */
  #indexKeysFor(scope: DataScope, value: T): string[] {
    const keys: string[] = []
    for (const field of this.#indexes) {
      const v = (value as Record<string, unknown>)[field]
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        keys.push(this.#filterIdx(scope, field, v))
      }
    }
    return keys
  }

  async get(key: string, scope: DataScope): Promise<Stored<T> | null> {
    const raw = await this.#port.hget(this.#key(scope, key), 'v')
    if (raw === null) return null
    const ver = await this.#port.hget(this.#key(scope, key), 'ver')
    const stored = this.#decode(raw, ver)
    if (stored.deletedAt !== undefined) return null // tombstone invisible
    return stored
  }

  async create(key: string, value: T, scope: DataScope): Promise<Stored<T>> {
    const reply = await this.#port.evalCas(
      [this.#key(scope, key), this.#scopeIdx(scope), ...this.#indexKeysFor(scope, value)],
      // Persist version 1 in the payload's place is irrelevant — #strip drops it;
      // the authoritative new version is the CAS reply (1, or tombstone+1 on resurrect).
      ['create', -1, JSON.stringify(this.#strip({ ...value } as Stored<T>)), this.#softDelete ? 1 : 0, ...this.#indexArgvTail(scope)],
    )
    if (reply === CONFLICT) {
      throw new Error(`Entity already exists at key '${key}'`)
    }
    return { ...value, version: reply } as Stored<T>
  }

  async put(key: string, value: T, scope: DataScope): Promise<Stored<T>> {
    const reply = await this.#port.evalCas(
      [this.#key(scope, key), this.#scopeIdx(scope), ...this.#indexKeysFor(scope, value)],
      ['put', -1, JSON.stringify(this.#strip(value)), this.#softDelete ? 1 : 0, ...this.#indexArgvTail(scope)],
    )
    return { ...value, version: reply } as Stored<T>
  }

  async update(
    key: string,
    value: T,
    expectedVersion: number | undefined,
    scope: DataScope,
  ): Promise<Stored<T>> {
    const reply = await this.#port.evalCas(
      [this.#key(scope, key), this.#scopeIdx(scope), ...this.#indexKeysFor(scope, value)],
      ['update', expectedVersion ?? -1, JSON.stringify(this.#strip(value)), this.#softDelete ? 1 : 0, ...this.#indexArgvTail(scope)],
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
    const existing = await this.#load(key, scope)
    if (!existing || existing.deletedAt !== undefined) {
      throw new Error(`Entity not found at key '${key}'`)
    }
    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw new OptimisticConflictError(
        `Version mismatch: expected ${expectedVersion}, found ${existing.version}`,
      )
    }
    const { version: _v, deletedAt: _d, ...current } = existing
    const merged = { ...current, ...partial } as unknown as T
    const reply = await this.#port.evalCas(
      [this.#key(scope, key), this.#scopeIdx(scope), ...this.#indexKeysFor(scope, merged)],
      // Guard on the version we just read so a racing writer still trips CONFLICT.
      ['patch', existing.version, JSON.stringify(this.#strip(merged)), this.#softDelete ? 1 : 0, ...this.#indexArgvTail(scope)],
    )
    this.#assertWritten(reply, key)
    return { ...merged, version: reply } as Stored<T>
  }

  async delete(
    key: string,
    expectedVersion: number | undefined,
    scope: DataScope,
  ): Promise<boolean> {
    let payload = '-'
    if (this.#softDelete) {
      const existing = await this.#load(key, scope)
      if (!existing || existing.deletedAt !== undefined) return false
      const tombstoned = { ...existing, deletedAt: new Date().toISOString() }
      payload = JSON.stringify(this.#strip(tombstoned as Stored<T>))
    }
    const reply = await this.#port.evalCas(
      [this.#key(scope, key), this.#scopeIdx(scope)],
      ['delete', expectedVersion ?? -1, payload, this.#softDelete ? 1 : 0, ...this.#indexArgvTail(scope)],
    )
    if (reply === MISS) return false
    if (reply === CONFLICT) {
      throw new OptimisticConflictError(
        `Version mismatch: expected ${expectedVersion}, stale delete on key '${key}'`,
      )
    }
    return true
  }

  async list(query: ListQuery, scope: DataScope): Promise<Page<T>> {
    // A non-positive limit would silently make all rows unreachable — fail fast.
    if (query.limit < 1) {
      throw new RangeError('list limit must be >= 1')
    }
    // Optional defense-in-depth clamp: lower the effective page size to maxLimit
    // when configured. Unset = no clamp = identical to the prior behavior.
    const effectiveLimit =
      this.#maxLimit !== undefined ? Math.min(query.limit, this.#maxLimit) : query.limit
    const idxKey =
      query.filter && this.#indexedFilterKey(scope, query.filter)
    const keys = idxKey
      ? (await this.#port.smembers(idxKey)).sort()
      : (await this.#port.smembers(this.#scopeIdx(scope))).sort()

    const residual = idxKey
      ? this.#residualFilter(query.filter!)
      : query.filter
    if (residual && Object.keys(residual).length > 0 && !idxKey) {
      console.warn(
        `[adapter-node] DataStore.list: filtering on non-declared index ` +
          `${Object.keys(residual).join(',')} via a capped client-side scan ` +
          `(cap=${SCAN_CAP}); declare it in @persisted(indexes) for an index SET.`,
      )
    }

    const after = query.cursor ? decodeCursor(query.cursor) : undefined
    const items: Stored<T>[] = []
    let lastKey: string | undefined
    let scanned = 0

    for (const ek of keys) {
      // Keys are sorted, so resume strictly past the cursor anchor. Using a
      // lexical `<=` (not an `=== after` match) is robust to the anchor having
      // been deleted between pages — otherwise the match never fires and every
      // remaining row is skipped.
      if (after !== undefined && ek <= after) continue
      if (++scanned > SCAN_CAP) break
      const raw = await this.#port.hget(ek, 'v')
      if (raw === null) continue
      const ver = await this.#port.hget(ek, 'ver')
      const stored = this.#decode(raw, ver)
      if (stored.deletedAt !== undefined) continue // tombstone invisible
      if (residual && !matchesFilter(stored, residual)) continue
      if (items.length >= effectiveLimit) {
        return { items, cursor: lastKey ? encodeCursor(lastKey) : undefined }
      }
      items.push(stored)
      lastKey = ek
    }
    return { items }
  }

  async count(
    query: Omit<ListQuery, 'cursor' | 'limit'>,
    scope: DataScope,
  ): Promise<number> {
    // Reuse list with a large page; backends with native COUNT override this.
    let n = 0
    let cursor: string | undefined
    do {
      const page = await this.list({ ...query, limit: 1000, cursor }, scope)
      n += page.items.length
      cursor = page.cursor
    } while (cursor)
    return n
  }

  // --- internals ----------------------------------------------------------

  /** Load the raw stored envelope (tombstones included) or null. */
  async #load(key: string, scope: DataScope): Promise<Stored<T> | null> {
    const raw = await this.#port.hget(this.#key(scope, key), 'v')
    if (raw === null) return null
    const ver = await this.#port.hget(this.#key(scope, key), 'ver')
    return this.#decode(raw, ver)
  }

  /** Reconstruct a {@link Stored} envelope from the stored JSON + version field. */
  #decode(rawJson: string, ver: string | null): Stored<T> {
    const obj = JSON.parse(rawJson) as Record<string, unknown>
    return { ...obj, version: ver === null ? 1 : Number(ver) } as Stored<T>
  }

  /** Drop the store-managed `version` from the persisted JSON (it lives in `ver`). */
  #strip(stored: Stored<T> | T): Record<string, unknown> {
    const { version: _v, ...rest } = stored as Record<string, unknown>
    return rest
  }

  /** First declared-index field present in the filter → its index SET key. */
  #indexedFilterKey(
    scope: DataScope,
    filter: Record<string, string | number | boolean>,
  ): string | undefined {
    for (const [field, value] of Object.entries(filter)) {
      if (this.#indexes.has(field)) return this.#filterIdx(scope, field, value)
    }
    return undefined
  }

  /** The filter minus the one field we resolved via an index SET. */
  #residualFilter(
    filter: Record<string, string | number | boolean>,
  ): Record<string, string | number | boolean> {
    let consumed = false
    const out: Record<string, string | number | boolean> = {}
    for (const [field, value] of Object.entries(filter)) {
      if (!consumed && this.#indexes.has(field)) {
        consumed = true
        continue
      }
      out[field] = value
    }
    return out
  }

  #assertWritten(reply: number, key: string): void {
    if (reply === MISS) throw new Error(`Entity not found at key '${key}'`)
    if (reply === CONFLICT) {
      throw new OptimisticConflictError(`Version mismatch on key '${key}'`)
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

// ---------------------------------------------------------------------------
// Real port — over RedisDataClientLike (no SDK import).
// ---------------------------------------------------------------------------

/**
 * Build the REAL {@link RedisDataPort} over a structural ioredis-style client.
 * The versioned-write path runs {@link CAS_LUA} via `EVAL`, atomic server-side
 * (no WATCH/MULTI retry loop needed). Production wiring:
 * `createRedisDataPort(new Redis(process.env.REDIS_URL))`.
 */
export function createRedisDataPort(client: RedisDataClientLike): RedisDataPort {
  return {
    async hget(key, field) {
      return client.hget(key, field)
    },
    async smembers(key) {
      return client.smembers(key)
    },
    async evalCas(keys, argv) {
      const reply = await client.eval(CAS_LUA, keys.length, ...keys, ...argv)
      return Number(reply)
    },
  }
}

// ---------------------------------------------------------------------------
// Fake port — in-process Maps, same atomicity synchronously.
// ---------------------------------------------------------------------------

/**
 * An in-process {@link RedisDataPort} backed by `Map`s. {@link evalCas} runs its
 * read-compare-write in one synchronous section before the returned promise
 * settles, so — exactly like the security-core memory stores — there is no
 * interleaving and the CAS atomicity contract holds under JS's single thread.
 * This validates all DataStore logic locally; the real Lua against a live server
 * is validated by `live.dataStore.test.ts` in CI.
 */
export function createFakeRedisDataPort(): RedisDataPort {
  /** entity key → { v: json, ver: number }. */
  const hashes = new Map<string, { v: string; ver: number }>()
  /** set key → member set. */
  const sets = new Map<string, Set<string>>()

  const addMember = (setKey: string, member: string): void => {
    let s = sets.get(setKey)
    if (!s) {
      s = new Set()
      sets.set(setKey, s)
    }
    s.add(member)
  }
  const remMember = (setKey: string, member: string): void => {
    sets.get(setKey)?.delete(member)
  }
  const isSoftTombstone = (json: string): boolean =>
    /"deletedAt":"/.test(json)

  return {
    async hget(key, field) {
      const h = hashes.get(key)
      if (!h) return null
      return field === 'ver' ? String(h.ver) : h.v
    },
    async smembers(key) {
      return Array.from(sets.get(key) ?? [])
    },
    async evalCas(keys, argv) {
      // Single synchronous read-compare-write == atomic EVAL equivalent.
      const [entity, scopeIdx, ...filterIdx] = keys
      const op = String(argv[0])
      const expected = Number(argv[1])
      const payload = String(argv[2])
      const soft = String(argv[3])
      // ARGV[5] = filter-index key prefix; ARGV[6..] = declared index field names
      // (1-based in Lua; 0-based here). Mirrors CAS_LUA so the fake and the real
      // server reindex identically.
      const fidxPrefix = String(argv[4])
      const indexFields = argv.slice(5).map(String)
      const cur = hashes.get(entity)
      const tombstoned = soft === '1' && cur !== undefined && isSoftTombstone(cur.v)

      // PRIOR filter-index keys from the currently-stored JSON, so a changed
      // indexed value (or a soft-delete) is removed from its old SETs.
      const oldFilterKeys = (): string[] => {
        if (!cur) return []
        let obj: Record<string, unknown>
        try {
          obj = JSON.parse(cur.v) as Record<string, unknown>
        } catch {
          return []
        }
        const out: string[] = []
        for (const field of indexFields) {
          const v = obj[field]
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            out.push(`${fidxPrefix}${field}=${String(v)}`)
          }
        }
        return out
      }
      const reindex = (): void => {
        for (const k of oldFilterKeys()) remMember(k, entity)
        for (const k of filterIdx) addMember(k, entity)
      }

      if (op === 'create') {
        if (cur && !tombstoned) return CONFLICT
        // Resurrecting a soft-delete tombstone CONTINUES the version (cur.ver + 1);
        // a first-ever create (or create after a HARD delete) starts at 1.
        const newVer = tombstoned && cur ? cur.ver + 1 : 1
        reindex()
        hashes.set(entity, { v: payload, ver: newVer })
        addMember(scopeIdx, entity)
        return newVer
      }
      if (op === 'put') {
        const newVer = cur ? cur.ver + 1 : 1
        reindex()
        hashes.set(entity, { v: payload, ver: newVer })
        addMember(scopeIdx, entity)
        return newVer
      }
      if (!cur || tombstoned) return MISS
      if (expected >= 0 && cur.ver !== expected) return CONFLICT

      if (op === 'update' || op === 'patch') {
        const newVer = cur.ver + 1
        reindex()
        hashes.set(entity, { v: payload, ver: newVer })
        addMember(scopeIdx, entity)
        return newVer
      }
      if (op === 'delete') {
        if (soft === '1') {
          // Tombstone the hash, but drop it from the scope + filter indexes.
          for (const k of oldFilterKeys()) remMember(k, entity)
          const newVer = cur.ver + 1
          hashes.set(entity, { v: payload, ver: newVer })
          remMember(scopeIdx, entity)
          return newVer
        }
        hashes.delete(entity)
        remMember(scopeIdx, entity)
        for (const k of oldFilterKeys()) remMember(k, entity)
        return cur.ver
      }
      return MISS
    },
  }
}

// ---------------------------------------------------------------------------
// Factory.
// ---------------------------------------------------------------------------

/**
 * Construct a Redis-backed {@link DataStore} over a {@link RedisDataPort}. Mirrors
 * the security stores: logic lives only against the port, so the same class
 * passes the `@smithy-hono/data-core` conformance suite against the in-process
 * fake and runs unchanged against real Redis in production.
 *
 * @example
 *   import Redis from 'ioredis'
 *   const store = createRedisDataStore(
 *     createRedisDataPort(new Redis(process.env.REDIS_URL!)),
 *     { prefix: 'todos:', indexes: ['ownerId'] },
 *   )
 */
export function createRedisDataStore<
  T extends Record<string, unknown> = Record<string, unknown>,
>(port: RedisDataPort, opts: RedisDataStoreOptions = {}): DataStore<T> {
  return new RedisDataStore<T>(port, opts)
}

export { RedisDataStore }
