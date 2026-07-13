import { defineDeployConfig } from '@smithy-hono/deploy-cf'

/**
 * One-command Cloudflare Workers deploy. The Worker owns `/api/*`; the built SPA
 * (if full-stack) serves everything else, same-origin. Run:
 *
 *   npm run deploy -- <your-domain>
 *
 * Prerequisites (the CLI cannot automate these):
 *   - `wrangler login` (or CLOUDFLARE_API_TOKEN set)
 *   - the domain must be an ACTIVE zone on your Cloudflare account (registrar
 *     nameservers delegated to Cloudflare)
 */
export default defineDeployConfig({
  appName: '{{APP_SLUG}}',
  workerEntry: 'src/worker.ts',
{{ASSETS_CONFIG}}
  bindings: {
    // D1 backs the Task DataStore (strongly-consistent SQL → full DataStore
    // contract). Binding name MUST be `DB` (src/worker.ts reads env.DB). The CLI
    // provisions the database and applies migrations/ on deploy.
    d1: [{ binding: 'DB', databaseName: '{{APP_SLUG}}-db', migrationsDir: 'migrations' }],
  },
})
