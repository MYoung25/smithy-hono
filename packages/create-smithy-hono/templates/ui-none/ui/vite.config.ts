import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In dev, the SPA calls the API same-origin (VITE_API_BASE unset → ''), so `/tasks`
// resolves to this Vite server; we proxy those paths to the local API on :3000
// (`npm run dev`). In the production build the deploy step sets `VITE_API_BASE=/api`
// so the same code hits `/api/tasks`, which the deploy front-door routes to the API.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/tasks': { target: 'http://localhost:3000', changeOrigin: true },
      '/healthz': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
})
