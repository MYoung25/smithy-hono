import { defineDeployConfig } from '@smithy-hono/deploy-cf'

/**
 * One-command Cloudflare Workers deploy for the SECURE service (seven-layer
 * security pipeline + OIDC cookie-session flow). The Worker owns `/api/*`; the
 * built SPA (if full-stack) serves everything else, same-origin. Run:
 *
 *   npm run deploy -- <your-domain>
 *
 * Prerequisites (the CLI cannot automate these):
 *   - `wrangler login` (or CLOUDFLARE_API_TOKEN set)
 *   - the domain must be an ACTIVE zone on your Cloudflare account
 *   - replace the OIDC placeholders below with YOUR IdP's facts, and put the
 *     confidential client secret in the gitignored deploy.secrets.json
 *
 * ⚠️ EPHEMERAL NOTES STORE: the deployed Worker (src/worker.ts) backs the `notes`
 * business data with an in-memory, per-isolate store — a DEMO store that is
 * NON-DURABLE and inconsistent across isolates/colos. The security stores (session
 * KV + nonce/rate-limit DO) ARE durable; only the notes data is not. For PRODUCTION,
 * wire a durable adapter (e.g. add a `d1` binding + migration below, or a Durable
 * Object, and swap the store in worker.ts).
 */
export default defineDeployConfig({
  appName: '{{APP_SLUG}}',
  workerEntry: 'src/worker.ts',
{{ASSETS_CONFIG}}
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

  // Non-secret OIDC facts from YOUR IdP. These PLACEHOLDER values MUST be replaced
  // with your provider's discovery issuer, registered client id, and endpoints
  // (e.g. an Auth0 / Okta / Keycloak / Google tenant). They surface into the Worker
  // `[vars]` and the post-deploy report.
  oidc: {
    issuer: 'https://your-tenant.example-idp.com/',
    clientId: 'your-registered-client-id',
    authorizeUrl: 'https://your-tenant.example-idp.com/authorize',
    tokenUrl: 'https://your-tenant.example-idp.com/oauth/token',
  },

  // Domain-derived Worker [vars]: the redirect URI + allowed CORS origin both track
  // the deploy domain (same-origin SPA).
  vars: ({ domain }) => ({
    OIDC_REDIRECT_URI: `https://${domain}/api/auth/callback`,
    ALLOWED_ORIGINS: `https://${domain}`,
  }),

  secretsFile: 'deploy.secrets.json',
})
