import { defineAwsDeployConfig } from '@smithy-hono/deploy-aws'

/**
 * One-command AWS deploy (CDK) for the SECURE service (seven-layer security
 * pipeline + OIDC cookie-session flow): a Lambda API + DynamoDB table, and —
 * full-stack — CloudFront in front of a private S3 SPA origin with `/api/*` routed
 * to the Lambda, same-origin. Run:
 *
 *   npm run deploy -- <your-domain>
 *
 * Prerequisites (the CLI cannot automate these):
 *   - AWS credentials configured (`aws configure` / SSO / env) + `cdk bootstrap`
 *     run once per account/region
 *   - run `npm run codegen` first so `src/generated/` exists (the Lambda bundle
 *     includes it)
 *   - for a custom domain: an ACM certificate in us-east-1 (CloudFront requirement)
 *     and DNS you can point at the CloudFront distribution
 *   - REPLACE the OIDC placeholder facts in `env` with YOUR IdP's values, and put
 *     the confidential client secret in the gitignored deploy.secrets.json
 *
 * ⚠️ EPHEMERAL NOTES STORE: the Lambda (src/handler.ts) backs the `notes` business
 * data with a per-invocation in-memory store — a DEMO store that does not persist
 * across Lambda instances. The SECURITY stores (session + nonce on DynamoDB) ARE
 * durable; only the notes data is not. For PRODUCTION, back notes with a durable
 * adapter store.
 */
export default defineAwsDeployConfig({
  appName: '{{APP_SLUG}}',
  handlerEntry: 'src/handler.ts',
{{ASSETS_CONFIG}}
  tableName: '{{APP_SLUG}}-data',

  // region: 'us-east-1',
  // Custom domain (both required together; cert MUST be in us-east-1):
  // domainName: 'app.example.com',
  // certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/....',

  // Auto-generated + materialized into Secrets Manager (fetched by the handler via
  // the CDK-injected SECRET_ARN_<NAME>). OIDC_CLIENT_SECRET is read from the
  // gitignored secrets file; drop it for a public PKCE client. SIGNING_KEY_IMPORTER_V1
  // is the demo S2S client's HMAC key (base64, keyId `importer-v1`).
  secrets: [
    { name: 'SIGNING_KEY_IMPORTER_V1', generate: 'hmac-base64' },
    { name: 'OIDC_STATE_SECRET', generate: 'hmac-base64' },
    { name: 'AUDIT_SALT', generate: 'random-base64' },
    { name: 'OIDC_CLIENT_SECRET', from: 'secretsFile' },
  ],

  env: ({ domain, apiPrefix }) => ({
    // ── Non-secret OIDC facts from YOUR IdP — REPLACE these placeholders with your
    //    provider's discovery issuer, registered client id, and endpoints. ───────
    OIDC_ISSUER: 'https://your-tenant.example-idp.com/',
    OIDC_CLIENT_ID: 'your-registered-client-id',
    OIDC_AUTHORIZE_URL: 'https://your-tenant.example-idp.com/authorize',
    OIDC_TOKEN_URL: 'https://your-tenant.example-idp.com/oauth/token',
    // Domain-derived (same-origin SPA): the redirect URI + allowed CORS origin.
    OIDC_REDIRECT_URI: `https://${domain}${apiPrefix}/auth/callback`,
    ALLOWED_ORIGINS: `https://${domain}`,
    // CloudFront fronts the Lambda, so its normalized X-Forwarded-* are trusted.
    TRUSTED_EDGE: 'true',
  }),

  secretsFile: 'deploy.secrets.json',
})
