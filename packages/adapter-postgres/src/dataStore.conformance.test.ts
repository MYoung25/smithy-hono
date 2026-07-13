/**
 * Run the `@smithy-hono/data-core` DataStore conformance suite against the
 * Postgres adapter wired to an in-process FAKE port. The fake honors the same
 * atomicity / consistency contract as real Postgres (each read-compare-write runs
 * in one synchronous JS section), so the optimistic-concurrency, scope-isolation,
 * filter, and pagination assertions exercise the real store logic. The live SQL
 * is validated by `live.postgres.dataStore.test.ts`.
 *
 * Postgres is the full-featured store: full optimistic concurrency (SQL CAS),
 * equality filter + count on ANY field (`WHERE value->>'field' = $n` — no client
 * scan), opaque-cursor pagination, and soft-delete. Asserted with declared
 * `indexes` so the filter test hits an indexed path; hard-delete + soft-delete
 * variants like adapter-cf / adapter-aws.
 */

import { describeDataStore } from '@smithy-hono/data-core/conformance'
import { createPostgresDataStore, createFakePgDataPort } from './dataStore.js'

// --- Postgres: hard-delete (default) — all caps except softDelete. -----------
describeDataStore(
  () => createPostgresDataStore(createFakePgDataPort(), { indexes: ['kind'] }),
  { optimisticConcurrency: true, pagination: true, filter: true, softDelete: false },
)

// --- Postgres: soft-delete — same, plus tombstone invisibility. --------------
describeDataStore(
  () => createPostgresDataStore(createFakePgDataPort(), { indexes: ['kind'], softDelete: true }),
  { optimisticConcurrency: true, pagination: true, filter: true, softDelete: true },
)
