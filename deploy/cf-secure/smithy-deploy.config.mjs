import { defineDeployConfig } from '@smithy-hono/deploy-cf'

/**
 * One-command Cloudflare deploy for the secure notes reference consumer.
 *
 * Serves `examples/secure-api` (the seven-layer security pipeline + OIDC
 * cookie-session flow) and the `examples/secure-ui` SPA SAME-ORIGIN: the Worker
 * owns `/api/*`, the static assets serve everything else (SPA fallback).
 *
 * Run from this directory: `npx smithy-hono-deploy <domain>` (or `npm run deploy
 * -- <domain>` from the repo root, which cds here first).
 *
 * ⚠️ EPHEMERAL NOTES STORE (DEPLOY-INFRA-09): the deployed Worker (src/worker.ts)
 * backs the `notes` business data with an in-memory, per-isolate store
 * (`createMemoryNotesStore`) — a DEMO store that is NON-DURABLE and inconsistent
 * across isolates/colos (writes are lost on cold start). The security stores
 * (session KV + nonce/rate-limit DO) ARE durable; only the notes data is not. For
 * PRODUCTION, wire a durable adapter (e.g. add a `d1` binding + migration below,
 * or a Durable Object, and swap the store in worker.ts). See README "Data
 * durability".
 */
export default defineDeployConfig({
  appName: 'smithy-hono-secure',
  workerEntry: 'src/worker.ts',

  assets: {
    dir: '../../examples/secure-ui/dist',
    // Build the browser auth helper first (the SPA aliases its built dist), then
    // build the SPA with the API base pinned to the same-origin `/api` prefix so
    // every auth + notes path resolves under the Worker's mount.
    buildCommand:
      'npm -w @smithy-hono/client-web run build && (cd ../../examples/secure-ui && VITE_API_BASE=/api npm run build)',
    apiPrefix: '/api',
    spa: true,
  },

  bindings: {
    kv: [{ binding: 'SESSIONS' }],
    durableObjects: [
      { name: 'SECURITY_DO', className: 'SecurityDurableObject', migrationTag: 'v1' },
    ],
  },

  // Auto-generated + synced via `wrangler secret put` on deploy. OIDC_CLIENT_SECRET
  // is read from the gitignored secrets file (deploy.secrets.json); drop it for a
  // public PKCE client.
  secrets: [
    { name: 'HMAC_KEY_2026A', generate: 'hmac-hex' },
    { name: 'OIDC_STATE_SECRET', generate: 'hmac-base64' },
    { name: 'AUDIT_SALT', generate: 'random-base64' },
    { name: 'OIDC_CLIENT_SECRET', from: 'secretsFile' },
  ],

  // Non-secret OIDC facts from YOUR IdP. These placeholder values MUST be replaced
  // with your provider's discovery issuer, registered client id, and endpoints
  // (e.g. an Auth0 / Okta / Keycloak / Google tenant). They surface into the
  // Worker `[vars]` and the post-deploy report.
  oidc: {
    issuer: 'https://your-tenant.example-idp.com/',
    clientId: 'your-registered-client-id',
    authorizeUrl: 'https://your-tenant.example-idp.com/authorize',
    tokenUrl: 'https://your-tenant.example-idp.com/oauth/token',
  },

  // Domain-derived Worker [vars]: the redirect URI + allowed CORS origin both
  // track the deploy domain (same-origin SPA).
  vars: ({ domain }) => ({
    OIDC_REDIRECT_URI: `https://${domain}/api/auth/callback`,
    ALLOWED_ORIGINS: `https://${domain}`,
  }),

  secretsFile: 'deploy.secrets.json',
})
