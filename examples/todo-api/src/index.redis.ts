import { serve } from '@hono/node-server'
import app from './server.redis'

const port = Number(process.env.PORT ?? 3000)

serve({ fetch: app.fetch, port }, () => {
  console.log(`Todo API (Redis-backed) running on http://0.0.0.0:${port}`)
})
