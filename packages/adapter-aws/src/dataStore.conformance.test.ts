/**
 * Run the `@smithy-hono/data-core` DataStore conformance suite against the AWS
 * adapter's DynamoDB store wired to an in-process FAKE port. The fake honors the
 * same conditional-write / version-CAS / scope-isolation contracts as real
 * DynamoDB, so the optimistic-concurrency, scope-isolation, filter, and
 * pagination assertions exercise the real store logic. The live DynamoDB command
 * protocol (conditional Put/Delete, GSI Query, `Select: 'COUNT'`,
 * `LastEvaluatedKey` pagination) is validated by `live.dynamodb.dataStore.test.ts`.
 *
 * DynamoDB is the full-featured analog of the cf D1 store: full optimistic
 * concurrency (conditional-write CAS), equality filter + count (GSI / partition
 * Query), opaque-cursor pagination, and soft-delete. Asserted with declared
 * `indexes` so the filter test hits the GSI path; hard-delete + soft-delete
 * variants like adapter-cf / adapter-node.
 */

import { describeDataStore } from '@smithy-hono/data-core/conformance'
import { createDynamoDataStore, createFakeDynamoDataPort } from './dataStore.js'

// --- DynamoDB: hard-delete (default) — all caps except softDelete. ----------
describeDataStore(
  () => createDynamoDataStore(createFakeDynamoDataPort(), { indexes: ['kind'] }),
  { optimisticConcurrency: true, pagination: true, filter: true, softDelete: false },
)

// --- DynamoDB: soft-delete — same, plus tombstone invisibility. -------------
describeDataStore(
  () => createDynamoDataStore(createFakeDynamoDataPort(), { indexes: ['kind'], softDelete: true }),
  { optimisticConcurrency: true, pagination: true, filter: true, softDelete: true },
)
