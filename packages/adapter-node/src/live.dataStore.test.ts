/**
 * LIVE conformance — runs the `@smithy-hono/data-core` DataStore conformance
 * suite against the Redis-backed {@link RedisDataStore} wired to a REAL Redis
 * server via the real {@link createRedisDataPort} over an `ioredis` client. This
 * validates the actual versioned-write Lua `EVAL` (optimistic CAS), the
 * declared-index SETs, and opaque-cursor pagination against a live server (the
 * fake exercises the same store logic in `dataStore.conformance.test.ts`).
 *
 * Gated on `REDIS_URL` so the normal suite skips it (no Docker required). To run:
 *
 *   docker run --rm -d -p 6379:6379 redis:7-alpine
 *   REDIS_URL=redis://localhost:6379 npx vitest run src/live.dataStore.test.ts
 *
 * Each factory call gets a unique key prefix, so the suite is isolated within the
 * shared Redis keyspace.
 */

import { beforeAll, afterAll, describe, it } from 'vitest'
import { describeDataStore } from '@smithy-hono/data-core/conformance'
import { createRedisDataPort, createRedisDataStore } from './dataStore.js'
import type { RedisDataClientLike } from './dataStore.js'

const REDIS_URL = process.env.REDIS_URL

/** ioredis satisfies RedisDataClientLike as-is; plus the lifecycle methods we drive. */
type LiveClient = RedisDataClientLike & {
  select(db: number): Promise<unknown>
  flushdb(): Promise<unknown>
  quit(): Promise<unknown>
}

/**
 * Vitest runs test FILES in parallel workers. `live.redis.test.ts` also connects
 * to the shared REDIS_URL and `flushdb()`s on start — a whole-DB wipe that would
 * nuke this file's in-flight rows mid-test (making a scope-isolation `get` return
 * `null`). Pin this file to its own logical DB via `SELECT` so the flushes can't
 * collide. Keep this index distinct from the one in `live.redis.test.ts`.
 */
const LIVE_DB = 2

if (!REDIS_URL) {
  describe.skip('adapter-node — live Redis DataStore conformance (set REDIS_URL to run)', () => {
    it('skipped — REDIS_URL not set', () => {})
  })
} else {
  let client: LiveClient
  let n = 0
  const prefix = (p: string): string => `live:ds:${p}:${++n}:`

  beforeAll(async () => {
    // Dynamic import so the file loads (and skips) even when ioredis is absent.
    const mod = (await import('ioredis')) as unknown as {
      default: new (url: string) => LiveClient
    }
    client = new mod.default(REDIS_URL)
    await client.select(LIVE_DB) // isolate from other parallel live-Redis test files
    await client.flushdb()
  })

  afterAll(async () => {
    if (client) await client.quit()
  })

  describeDataStore(
    () =>
      createRedisDataStore(createRedisDataPort(client), {
        prefix: prefix('hard'),
        indexes: ['kind'],
      }),
    { optimisticConcurrency: true, pagination: true, filter: true, softDelete: false },
  )

  describeDataStore(
    () =>
      createRedisDataStore(createRedisDataPort(client), {
        prefix: prefix('soft'),
        indexes: ['kind'],
        softDelete: true,
      }),
    { optimisticConcurrency: true, pagination: true, filter: true, softDelete: true },
  )
}
