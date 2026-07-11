import { serve } from '@hono/node-server'
import app from './server'

const port = Number(process.env.PORT ?? 3000)

serve({ fetch: app.fetch, port }, () => {
  console.log(`Secure API (Redis-backed) running on http://0.0.0.0:${port}`)
})
