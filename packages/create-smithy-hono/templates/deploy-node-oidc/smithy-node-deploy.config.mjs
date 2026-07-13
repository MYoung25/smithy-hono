import { defineNodeDeployConfig } from '@smithy-hono/deploy-node'

/**
 * One-command Node/Kubernetes deploy for the SECURE service (seven-layer security
 * pipeline + OIDC cookie-session flow). Builds the API container (and, full-stack,
 * an nginx front-door that serves the SPA and proxies `/api/*` to the API,
 * same-origin), renders the k8s manifests, applies them, and probes
 * `https://<domain>/api/healthz`. Run:
 *
 *   npm run deploy -- <your-domain>
 *
 * Prerequisites (the CLI cannot automate these):
 *   - a working `kubectl` context pointing at your cluster
 *   - an Ingress controller + cert-manager ClusterIssuer (for the TLS host)
 *   - a container registry you can push to (set `registry` below) — or a cluster
 *     that can pull the locally-built image
 *   - run `npm run codegen` first so `src/generated/` exists for the image build
 *   - REPLACE the OIDC placeholder facts in `env` with YOUR IdP's values, and put
 *     the confidential client secret in the gitignored deploy.secrets.json
 *   - for a durable, multi-replica security store, point `REDIS_URL` at an
 *     in-cluster Redis (uncomment below); without it each pod uses an in-memory
 *     store (single-replica / demo).
 */
export default defineNodeDeployConfig({
  appName: '{{APP_SLUG}}',
{{ASSETS_CONFIG}}
  namespace: 'default',

  // Image registry to tag + push, e.g. 'registry.example.com/you'. Leave unset to
  // build the image locally only (the cluster must then be able to load/pull it).
  // registry: 'registry.example.com/you',

  // Auto-generated + synced into a k8s Secret. OIDC_CLIENT_SECRET is read from the
  // gitignored secrets file (deploy.secrets.json); drop it for a public PKCE client.
  // SIGNING_KEY_IMPORTER_V1 is the demo S2S client's HMAC key (base64, read by the
  // adapter-node envSecretSource for keyId `importer-v1`).
  secrets: [
    { name: 'SIGNING_KEY_IMPORTER_V1', generate: 'hmac-base64' },
    { name: 'OIDC_STATE_SECRET', generate: 'hmac-base64' },
    { name: 'AUDIT_SALT', generate: 'random-base64' },
    { name: 'OIDC_CLIENT_SECRET', from: 'secretsFile' },
  ],

  env: ({ domain, apiPrefix }) => ({
    // ── Non-secret OIDC facts from YOUR IdP — REPLACE these placeholders with your
    //    provider's discovery issuer, registered client id, and endpoints (e.g. an
    //    Auth0 / Okta / Keycloak / Google tenant). ──────────────────────────────
    OIDC_ISSUER: 'https://your-tenant.example-idp.com/',
    OIDC_CLIENT_ID: 'your-registered-client-id',
    OIDC_AUTHORIZE_URL: 'https://your-tenant.example-idp.com/authorize',
    OIDC_TOKEN_URL: 'https://your-tenant.example-idp.com/oauth/token',
    // Domain-derived (same-origin SPA): the redirect URI + allowed CORS origin.
    OIDC_REDIRECT_URI: `https://${domain}${apiPrefix}/auth/callback`,
    ALLOWED_ORIGINS: `https://${domain}`,
    // Point at an in-cluster Redis for a durable, multi-replica security store;
    // without it each pod uses an in-memory per-pod store (single-replica / demo).
    // REDIS_URL: 'redis://redis:6379',
    // Honor the front-door's X-Forwarded-Proto (TLS terminates at the Ingress).
    TRUST_PROXY_HEADERS: '1',
  }),

  secretsFile: 'deploy.secrets.json',
})
