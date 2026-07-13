/**
 * Node deploy entry (container): the app served by `@hono/node-server` under
 * `/api`, backed by a Redis DataStore when `REDIS_URL` is set (durable, multi-
 * replica) and an in-memory store otherwise (fine for a single replica / demo).
 * The nginx front-door (rendered by `@smithy-hono/deploy-node`) proxies `/api/*`
 * here and serves the SPA for everything else, same-origin.
 */
import { serve } from '@hono/node-server'
import Redis from 'ioredis'
import type { DataStore } from '@smithy-hono/data-core'
import { createMemoryDataStore } from '@smithy-hono/data-core/memory'
import {
  createRedisDataStore,
  createRedisDataPort,
  type RedisDataClientLike,
} from '@smithy-hono/adapter-node'
import { createApp } from './createApp'
import type { TaskData } from './generated/task.gen'

const redisUrl = process.env.REDIS_URL
const store: DataStore<TaskData> = redisUrl
  ? createRedisDataStore<TaskData>(
      createRedisDataPort(new Redis(redisUrl) as unknown as RedisDataClientLike),
      { prefix: 'tasks:' },
    )
  : createMemoryDataStore<TaskData>()

const { app } = createApp({ store, basePath: '/api' })
const port = Number(process.env.PORT ?? 3000)

serve({ fetch: app.fetch, port }, () => {
  console.log(`API (${redisUrl ? 'redis' : 'in-memory'} store) running on :${port}`)
})
