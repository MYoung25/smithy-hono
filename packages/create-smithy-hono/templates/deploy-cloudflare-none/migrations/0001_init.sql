-- D1 schema for the Task store — the canonical @smithy-hono/adapter-cf DataStore
-- table (d1CreateTableSql('tasks')): scope+id primary key, JSON value blob, version
-- column for optimistic-concurrency CAS, deleted_at soft-delete tombstone.
--
-- Applied automatically by `npm run deploy`; for local dev:
--   wrangler d1 migrations apply {{APP_SLUG}}-db --local

CREATE TABLE IF NOT EXISTS "tasks" (
  scope TEXT NOT NULL,
  id TEXT NOT NULL,
  value TEXT NOT NULL,
  version INTEGER NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (scope, id)
);
