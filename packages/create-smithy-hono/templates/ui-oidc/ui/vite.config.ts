import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Hardened Content-Security-Policy for the production static SPA document.
// The build emits only same-origin hashed `/assets/*.js` + `/assets/*.css`
// (no inline scripts), so `'self'` is sufficient and we avoid `'unsafe-inline'`.
// `form-action 'self'` also backstops the open-redirect concern.
// NOTE: `frame-ancestors` / `X-Frame-Options` / `Referrer-Policy` /
// `X-Content-Type-Options` are not honored as `<meta>` tags by browsers — they must
// be sent as real response headers by the static front door (the deploy target does this).
const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ')

// Inject the CSP meta only into the BUILT index.html (the production front-door
// document). The Vite dev server injects inline HMR scripts + a websocket, so a
// strict meta-CSP would break `npm run dev`; dev gets its policy via
// `server.headers` below instead.
const cspMetaPlugin: Plugin = {
  name: 'ui-csp-meta',
  apply: 'build',
  transformIndexHtml(html) {
    return {
      html,
      tags: [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: PROD_CSP },
          injectTo: 'head-prepend',
        },
      ],
    }
  },
}

// Dev-server security headers. CSP is relaxed vs. production to keep Vite HMR
// working (inline preamble script, websocket for hot reload, inline styles from
// the Tailwind dev pipeline) while still exercising the same baseline directives.
const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ')

const DEV_SECURITY_HEADERS = {
  'Content-Security-Policy': DEV_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
}

// In dev the SPA calls the API same-origin (VITE_API_BASE unset → ''), so `/auth`,
// `/notes`, `/csrf-token` resolve to this Vite server; we proxy those paths to the
// local API on :3000 (`npm run dev`). In the production build the deploy step sets
// `VITE_API_BASE=/api` so the same code hits `/api/*`, which the deploy front-door
// routes to the API.
export default defineConfig({
  plugins: [react(), tailwindcss(), cspMetaPlugin],
  server: {
    port: 5173,
    headers: DEV_SECURITY_HEADERS,
    proxy: {
      '/auth': { target: 'http://localhost:3000', changeOrigin: true },
      '/notes': { target: 'http://localhost:3000', changeOrigin: true },
      '/csrf-token': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
})
