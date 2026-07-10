/**
 * Run the `@smithy-hono/data-core` DataStore conformance suite against the
 * Redis-backed {@link RedisDataStore} wired to the in-process FAKE port. The fake
 * honors the same CAS atomicity contract as real Redis synchronously, so the
 * optimistic-concurrency and scope-isolation assertions exercise the real store
 * logic. The live Lua against a real server is validated by `live.dataStore.test.ts`.
 *
 * Redis capabilities: full optimistic concurrency (Lua CAS), pagination (opaque
 * cursor over the scope-index SET), and equality filter. Soft-delete is a
 * construction option, so each variant is asserted under its own descriptor.
 */

import { describeDataStore } from '@smithy-hono/data-core/conformance'
import { createFakeRedisDataPort, createRedisDataStore } from './dataStore.js'

// Hard-delete store (default): all caps except softDelete.
describeDataStore(
  () => createRedisDataStore(createFakeRedisDataPort(), { indexes: ['kind'] }),
  { optimisticConcurrency: true, pagination: true, filter: true, softDelete: false },
)

// Soft-delete store: same, plus tombstone invisibility.
describeDataStore(
  () =>
    createRedisDataStore(createFakeRedisDataPort(), {
      indexes: ['kind'],
      softDelete: true,
    }),
  { optimisticConcurrency: true, pagination: true, filter: true, softDelete: true },
)
