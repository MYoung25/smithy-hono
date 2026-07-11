import { serve } from '@hono/node-server'
import { createCrudApp } from './createApp'

const { app } = createCrudApp()

serve({ fetch: app.fetch, port: 3000 }, () => {
  console.log('CRUD API (zero-handler, memory store) running on http://localhost:3000')
})
