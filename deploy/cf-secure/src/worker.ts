/**
 * Cloudflare Worker entry for the SECURE notes reference consumer: the
 * `examples/secure-api` service (all seven security layers + the OIDC
 * cookie-session flow) and the `examples/secure-ui` SPA, served SAME-ORIGIN with
 * the API mounted under `/api` (the UI's static assets serve everything else).
 *
 * The three backed stores (session / rate-limit / nonce) plus the S2S secret
 * provider come from the Cloudflare adapter over Workers KV + a Durable Object
 * (`createCloudflareSecurityStores`); the OIDC verifier is built LAZILY on first
 * request (`lazyOidcVerifier`) because Workers forbid network at module init.
 *
 * ARCH-01: web-standard APIs only — no `node:*` import anywhere in this file or
 * its imports. The adapter never imports a Cloudflare SDK; the bindings on `Env`
 * structurally satisfy the adapter's narrow `*Like` ports, so this typechecks
 * WITHOUT `@cloudflare/workers-types`.
 *
 * The Durable Object class `SecurityDurableObject` is re-exported below so
 * `wrangler.toml`'s `[[durable_objects.bindings]] class_name` can resolve it.
 */

import {
  createCloudflareSecurityStores,
  lazyOidcVerifier,
  createConsoleLogger,
  createConsoleAuditSink,
  forwardedProtoHeader,
  clientIp,
} from '@smithy-hono/adapter-cf'
import { createSecureApp } from '../../../examples/secure-api/src/createApp'
import { createMemoryNotesStore } from '../../../examples/secure-api/src/notesStore'

// Re-export the Durable Object class so wrangler can bind it (see wrangler.toml:
// `[[durable_objects.bindings]] class_name = "SecurityDurableObject"`).
export { SecurityDurableObject } from '@smithy-hono/adapter-cf'

/**
 * The bindings this Worker reads. Each name MUST match the rendered
 * `wrangler.toml` (see smithy-deploy.config.mjs) and the adapter's structural
 * ports. Typed structurally so this entry typechecks WITHOUT
 * `@cloudflare/workers-types`.
 */
export interface Env {
  /** Workers KV namespace backing the SessionStore (eventual consistency OK). */
  SESSIONS: {
    get(key: string): Promise<string | null>
    put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
    delete(key: string): Promise<void>
  }
  /** Durable Object namespace backing the rate-limit + nonce stores (strong). */
  SECURITY_DO: {
    idFromName(name: string): unknown
    get(id: unknown): { fetch(request: Request): Promise<Response> }
  }
  /** Demo S2S client's HMAC signing key, lowercase-hex (generated secret). */
  HMAC_KEY_2026A: string
  /** OIDC issuer (discovery base) — non-secret IdP fact. */
  OIDC_ISSUER: string
  /** Registered OIDC client id — non-secret IdP fact (also the token audience). */
  OIDC_CLIENT_ID: string
  /** Confidential-client secret. Optional: omit for a public PKCE client. */
  OIDC_CLIENT_SECRET?: string
  /** IdP authorize endpoint. */
  OIDC_AUTHORIZE_URL: string
  /** IdP token endpoint. */
  OIDC_TOKEN_URL: string
  /** This deployment's OIDC redirect URI (`https://<domain>/api/auth/callback`). */
  OIDC_REDIRECT_URI: string
  /** HMAC secret signing the login↔callback transaction cookie (generated). */
  OIDC_STATE_SECRET: string
  /** Per-deployment pseudonymization salt for audit refs (generated). */
  AUDIT_SALT: string
  /** Comma-separated list of allowed CORS origins for the SPA. */
  ALLOWED_ORIGINS: string
}

// Module-scope memoized OIDC verifier getter. `createOidcVerifier` does a
// discovery `fetch`, which Workers forbid at module init — so it is built lazily
// on the first request and cached for the isolate's lifetime.
let getVerifier: ReturnType<typeof lazyOidcVerifier> | undefined

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    getVerifier ??= lazyOidcVerifier({ issuer: env.OIDC_ISSUER, audience: env.OIDC_CLIENT_ID })

    // Session → KV, nonce/rate-limit → Durable Object, secrets → env HMAC material.
    const { session, nonce, secrets } = createCloudflareSecurityStores(env, {
      secrets: {
        material: { 'importer-v1': env.HMAC_KEY_2026A },
        currentByClient: { importer: 'importer-v1' },
      },
    })

    const { app } = createSecureApp({
      // Mount the whole service under `/api`; the SPA assets serve everything else.
      basePath: '/api',
      // ⚠️ DEMO / EPHEMERAL DATA PLANE (DEPLOY-INFRA-09) — NOT durable.
      // `createMemoryNotesStore()` is a per-isolate `Map`: it is recreated on every
      // cold start and DIVERGES across the concurrently-serving isolates/colos that
      // Cloudflare runs, so notes writes are lost on isolate recycle and invisible
      // across isolates. The SECURITY stores (session KV, nonce/rate-limit DO) are
      // durable; only this business-data store is not. This reference deploy ships
      // the in-memory store so it runs with zero extra provisioning, but it is NOT
      // production-grade persistence.
      //
      // FOR PRODUCTION: replace this with a durable adapter — a D1-backed notes
      // store (declare a `d1` binding in smithy-deploy.config.mjs + a migration) or
      // a Durable Object — so writes survive isolate recycle and are consistent
      // across isolates/colos. Keep the `NotesStore` port contract; only swap the
      // backing implementation.
      notesStore: createMemoryNotesStore(),
      stores: { session, nonce, secrets: secrets! },
      oidcVerifier: await getVerifier(),
      logger: createConsoleLogger(),
      audit: createConsoleAuditSink({ base: { service: 'secure-api' } }),
      auditSalt: env.AUDIT_SALT,
      oidc: {
        issuer: env.OIDC_ISSUER,
        clientId: env.OIDC_CLIENT_ID,
        clientSecret: env.OIDC_CLIENT_SECRET,
        audience: env.OIDC_CLIENT_ID,
        redirectUri: env.OIDC_REDIRECT_URI,
        authorizationEndpoint: env.OIDC_AUTHORIZE_URL,
        tokenEndpoint: env.OIDC_TOKEN_URL,
      },
      oidcStateSecret: env.OIDC_STATE_SECRET,
      // CF-Visitor scheme + spoof-resistant CF-Connecting-IP (the adapter glue).
      forwardedProtoHeader,
      clientIp,
      allowedOrigins: env.ALLOWED_ORIGINS.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    })

    return app.fetch(request)
  },
}
