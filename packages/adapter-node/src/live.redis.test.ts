/**
 * LIVE conformance — runs the security-core storage conformance suites against
 * the Redis-backed stores wired to a REAL Redis server via the real
 * {@link createRedisPort} over an `ioredis` client. This validates the actual
 * Lua `EVAL` token bucket and `SET NX` nonce against a live server (the
 * strong-consistency guarantees `conformance.test.ts` exercises only through the
 * in-process fake).
 *
 * Gated on `REDIS_URL` so the normal suite skips it (no Docker required). To run:
 *
 *   docker run --rm -d -p 6379:6379 redis:7-alpine
 *   REDIS_URL=redis://localhost:6379 npx vitest run src/live.redis.test.ts
 *
 * Each factory call gets a unique key prefix, so the suites are isolated within
 * the shared Redis keyspace.
 */

import { beforeAll, afterAll, describe, it } from 'vitest'
import {
  describeSessionStore,
  describeRateLimitStore,
  describeNonceStore,
} from '@smithy-hono/security-core/storage/conformance'
import { createRedisPort } from './ports.js'
import type { RedisClientLike } from './ports.js'
import {
  RedisSessionStore,
  RedisRateLimitStore,
  RedisNonceStore,
} from './stores.js'

const REDIS_URL = process.env.REDIS_URL

/** ioredis satisfies RedisClientLike as-is; plus the lifecycle methods we drive. */
type LiveClient = RedisClientLike & {
  select(db: number): Promise<unknown>
  flushdb(): Promise<unknown>
  quit(): Promise<unknown>
}

/**
 * Vitest runs test FILES in parallel workers. Every live-Redis file connects its
 * OWN client to the shared REDIS_URL and `flushdb()`s in `beforeAll` for a clean
 * slate — but FLUSHDB wipes the whole logical DB, so one file's flush would nuke
 * another file's in-flight rows (a scope-isolation `get` would then see `null`).
 * Pin each file to a distinct logical DB via `SELECT` so a flush stays local.
 */
const LIVE_DB = 1

if (!REDIS_URL) {
  describe.skip('adapter-node — live Redis conformance (set REDIS_URL to run)', () => {
    it('skipped — REDIS_URL not set', () => {})
  })
} else {
  let client: LiveClient
  let n = 0
  const prefix = (p: string): string => `live:${p}:${++n}:`

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

  describeSessionStore(
    'RedisSessionStore (live Redis)',
    () => new RedisSessionStore(createRedisPort(client), { prefix: prefix('sess') }),
  )
  describeRateLimitStore(
    'RedisRateLimitStore (live Redis)',
    () => new RedisRateLimitStore(createRedisPort(client), { prefix: prefix('rl') }),
  )
  describeNonceStore(
    'RedisNonceStore (live Redis)',
    () => new RedisNonceStore(createRedisPort(client), { prefix: prefix('nonce') }),
  )
}
