import { serve } from '@hono/node-server'
import app from './server'

serve({ fetch: app.fetch, port: 3000 }, () => {
  console.log('Todo API running on http://localhost:3000')
})
