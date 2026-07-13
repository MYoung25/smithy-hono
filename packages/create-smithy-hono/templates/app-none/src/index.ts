/**
 * Local dev entry: the app on Node with an in-memory store, no base path (routes at
 * root, matching the Vite dev proxy). The deploy entry (worker / server / lambda)
 * injects a durable store and the `/api` base path instead.
 */
import { serve } from '@hono/node-server'
import { createApp } from './createApp'

const { app } = createApp()

serve({ fetch: app.fetch, port: 3000 }, () => {
  console.log('API (dev, in-memory store) running on http://localhost:3000')
})
