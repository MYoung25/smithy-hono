import { defineConfig, type Plugin } from 'vite'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Resolve workspace paths relative to THIS file (examples/secure-ui).
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// Hardened Content-Security-Policy for the production static SPA document.
// The build emits only same-origin hashed `/assets/*.js` + `/assets/*.css`
// (no inline scripts), so `'self'` is sufficient and we avoid `'unsafe-inline'`.
// `form-action 'self'` also backstops the open-redirect concern (CLIENT-WEB-XSS-01).
// NOTE: `frame-ancestors` / `X-Frame-Options` / `Referrer-Policy` /
// `X-Content-Type-Options` are not honored as `<meta>` tags by browsers — they must
// be sent as real response headers by the static front door (see deploy/node-web).
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
  name: 'secure-ui-csp-meta',
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
// the Tailwind dev pipeline) while still exercising the same baseline directives
// so CSP violations surface early.
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

// We consume `@smithy-hono/client-web` WITHOUT any npm tarball / lockfile
// machinery (so this example never touches the root build / CI): a Vite alias maps
// the bare specifier to the package's already-built `dist`. Run
// `npm -w @smithy-hono/client-web run build` once so that dist exists. The
// generated secure-api types are imported by relative path (see src/notesClient.ts),
// so they need no alias — only `server.fs.allow` to let Vite read them.
export default defineConfig({
  plugins: [react(), tailwindcss(), cspMetaPlugin],
  resolve: {
    alias: {
      '@smithy-hono/client-web': r('../../packages/client-web/dist/index.js'),
    },
  },
  server: {
    port: 5173,
    headers: DEV_SECURITY_HEADERS,
    // Same-origin in dev: forward the auth routes + the notes resource prefix +
    // the CSRF-token route to the secure-api dev server (examples/secure-api on
    // :3000). Start it first: `cd ../secure-api && npm run dev`.
    proxy: {
      '/auth': { target: 'http://localhost:3000', changeOrigin: true },
      '/notes': { target: 'http://localhost:3000', changeOrigin: true },
      '/csrf-token': { target: 'http://localhost:3000', changeOrigin: true },
    },
    // Allow Vite to read the aliased client-web dist + the generated secure-api
    // types, which live outside this package root.
    fs: {
      allow: [r('.'), r('../../packages/client-web'), r('../secure-api/generated')],
    },
  },
})
