/**
 * `@smithy-hono/adapter-postgres` — the Postgres-backed `DataStore<T>` for
 * `@smithy-hono/data-core` (Plan 13 D7).
 *
 * Postgres is the **recommended durable store of record for the Node
 * deployment**: a `jsonb` value column with versioned CAS, server-side
 * `WHERE value->>'field' = $n` filtering on ANY field (no client scan), opaque-
 * cursor pagination, and soft-delete. The Redis `DataStore` in
 * `@smithy-hono/adapter-node` is the optional cache-grade alternative.
 *
 * All store logic runs against a narrow SEMANTIC port ({@link PgDataPort}); the
 * real port ({@link createPgDataPort}) is the only place that speaks SQL, over a
 * structural client ({@link PgClientLike}) so nothing here imports the `pg`
 * driver at runtime (ARCH-01). The in-process fake ({@link createFakePgDataPort})
 * backs the always-on conformance suite; the live test validates the real SQL.
 */

// --- DataStore<T> factory + class (Plan 13 D7) ------------------------------
export {
  createPostgresDataStore,
  PostgresDataStore,
  type PostgresDataStoreOptions,
} from './dataStore.js'

// --- Ports: the SEMANTIC port + the real/fake builders + structural client ---
export {
  createPgDataPort,
  createFakePgDataPort,
  type PgDataPort,
  type PgDataPortOptions,
  type PgClientLike,
  type PgRow,
  type PgListArgs,
} from './dataStore.js'

// --- Schema helpers (the consumer runs these as a migration) ----------------
export {
  pgCreateTableSql,
  pgCreateIndexSql,
  PG_TABLE_DEFAULT,
} from './dataStore.js'
