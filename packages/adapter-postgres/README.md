# @smithy-hono/adapter-postgres

Postgres-backed `DataStore<T>` for [`@smithy-hono/data-core`](../data-core)
(Plan 13 D7). It maps the `DataStore<T>` persistence port onto Postgres over a
narrow *structural client port* so nothing here imports the `pg` driver at
runtime (ARCH-01).

**Postgres is the recommended durable store of record for the Node deployment.**
The Redis `DataStore` in [`@smithy-hono/adapter-node`](../adapter-node) is the
optional **cache-grade** alternative — for ephemeral/cache-like entities or shops
already running Redis. Redis is RAM-bound and weaker at rich list/filter/count
(it needs hand-maintained index SETs + a capped client-side scan for undeclared
filters). For durable CRUD, reach for Postgres. (Redis remains correct for the
*security* stores — that is a separate concern.)

| Concern | Backend | Class / fn | Consistency |
|---------|---------|------------|-------------|
| `DataStore<T>` | Postgres (`jsonb`) | `PostgresDataStore` / `createPostgresDataStore` | **strong** (SQL CAS) |

Full capabilities: optimistic concurrency (versioned CAS), equality `filter` +
`count` on **any** field (server-side, no client scan), opaque-cursor
pagination, and (opt-in) soft-delete.

## The PORT pattern

The store never imports `pg`. All logic runs against a narrow **SEMANTIC** port
(`PgDataPort` — `getRow` / `insertIfAbsent` / `putRow` / `updateCas` /
`deleteCas` / `listRows` / `count`), never raw SQL. Two ports satisfy it:

- **`createPgDataPort(client, table?)`** — the REAL port, the only place that
  speaks SQL. It codes against a structural **`PgClientLike`**:

  ```ts
  interface PgClientLike {
    query(text: string, params?: unknown[]): Promise<{
      rows: Array<Record<string, unknown>>
      rowCount: number | null
    }>
  }
  ```

  A `pg` `Pool`/`Client` is a structural superset; a `postgres.js` client
  (adapted to this `query` shape) or a Neon serverless client satisfies it too.
  All queries are parameterized (`$1`, `$2`, ...).
- **`createFakePgDataPort()`** — an in-process port over a `Map` that honors the
  SAME atomicity contract synchronously (single JS tick == atomic). It backs the
  always-on conformance suite, so all store logic is exercised with no Postgres.

## Table schema (run as a migration)

The adapter never issues DDL at runtime. The consumer runs `pgCreateTableSql()`
(+ a `pgCreateIndexSql()` per declared `@persisted` index) once per collection:

```sql
CREATE TABLE IF NOT EXISTS "data_store" (
  scope text NOT NULL,
  id text NOT NULL,
  value jsonb NOT NULL,
  version bigint NOT NULL,
  deleted_at timestamptz,
  PRIMARY KEY (scope, id)
);
-- one per declared @persisted index field (a short field-name hash is appended
-- to the index name to keep distinct fields from colliding):
CREATE INDEX IF NOT EXISTS "data_store_idx_ownerId_e51b6a79"
  ON "data_store" (scope, (value->>'ownerId'));
```

- `(scope, id)` is the composite PRIMARY KEY → tenant A literally cannot address
  tenant B's rows (cross-scope `get` returns `null`), and the same key in two
  scopes never collides. `scope` is a length-prefixed `DataScope` segment.
- `value` is `jsonb`, so an equality filter on **any** field is a server-side
  `WHERE value->>'field' = $n` — **there is no client-side scan fallback**.
  Declared indexes are purely a performance optimization (btree expression
  indexes that keep the filter sargable at scale); an undeclared filter is still
  answered server-side, just without a dedicated index.
- `version` (`bigint`) is the optimistic-concurrency token; a versioned write is
  a single conditional `UPDATE ... WHERE version = $` whose `rowCount` we inspect.
- `deleted_at` (`timestamptz`) is NULL for live rows; a tombstone when
  soft-deleted (hidden from `get`/`list`/`count`).

## Consumer wiring

### node-postgres (`pg`)

```ts
import { Pool } from 'pg'
import {
  createPostgresDataStore,
  createPgDataPort,
  pgCreateTableSql,
  pgCreateIndexSql,
} from '@smithy-hono/adapter-postgres'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

// Migration (once):
await pool.query(pgCreateTableSql('todos'))
await pool.query(pgCreateIndexSql('todos', 'ownerId'))

const store = createPostgresDataStore(
  createPgDataPort(pool, 'todos'),
  { table: 'todos', indexes: ['ownerId'], softDelete: false },
)
// const ops = createDefaultTodoOperations(store)   // zero-handler CRUD
```

### postgres.js

`postgres.js`'s tagged-template client is not `PgClientLike`-shaped, so wrap it:

```ts
import postgres from 'postgres'
const sql = postgres(process.env.DATABASE_URL!)
const client = {
  async query(text: string, params: unknown[] = []) {
    const rows = await sql.unsafe(text, params as never[])
    return { rows: rows as unknown as Array<Record<string, unknown>>, rowCount: rows.count }
  },
}
const store = createPostgresDataStore(createPgDataPort(client, 'todos'), { table: 'todos' })
```

### Neon serverless

The Neon serverless driver exports a `pg`-compatible `Pool`, so it satisfies
`PgClientLike` directly:

```ts
import { Pool } from '@neondatabase/serverless'
const store = createPostgresDataStore(
  createPgDataPort(new Pool({ connectionString: process.env.DATABASE_URL })),
)
```

## Test / verify

```
npx tsc --noEmit -p tsconfig.build.json   # types (source-only, ARCH-01 guard)
npx vitest run                            # conformance (fake-backed)
```

The always-on conformance (`src/dataStore.conformance.test.ts`) runs the
`@smithy-hono/data-core` `describeDataStore` suite against `createFakePgDataPort`
— full capabilities, hard-delete + soft-delete variants — so it proves adapter
logic with root-hoisted tooling only (no Postgres, no `pg` install).

## Live verification (real Postgres)

`src/live.postgres.dataStore.test.ts` (gated on `DATABASE_URL` / `POSTGRES_URL`,
self-skips when unset) runs the SAME conformance suite against a **real
Postgres** via the real `createPgDataPort` over a `pg` `Pool` — validating the
genuine versioned CAS, `INSERT ... ON CONFLICT`, `WHERE value->>'field'` filter +
`COUNT(*)`, and opaque-cursor pagination server-side. `pg` is imported via a
non-literal specifier so the file typechecks without it installed. Run it locally
with `./scripts/verify-live.sh` (Postgres in Docker) or in CI via
`.github/workflows/live-conformance.yml` (a `postgres:16-alpine` service
container).
