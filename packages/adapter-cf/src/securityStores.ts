/**
 * Reusable Worker-side wiring for the `@smithy-hono/security-core` stores over
 * Cloudflare backends. This collapses the boilerplate every consuming Worker
 * would otherwise copy (see the long-hand version in `deploy/cf/src/worker.ts`)
 * into a single call, so an app entry is ~15 lines:
 *
 * ```ts
 * const { session, nonce, secrets } = createCloudflareSecurityStores(env, {
 *   secrets: { material: { 'importer-v1': env.HMAC_KEY_2026A }, currentByClient: { importer: 'importer-v1' } },
 * })
 * ```
 *
 * ARCH-01: still web-standard only — these are thin constructors over the
 * adapter's existing stores; the `env` bindings satisfy narrow structural ports,
 * so no `@cloudflare/workers-types` / SDK is required.
 */

import type { KvNamespaceLike } from './ports.js'
import { KvSessionStore } from './sessionStore.js'
import { DurableNonceStore } from './nonceStore.js'
import { DurableRateLimitStore } from './rateLimitStore.js'
import {
  createFetchNonceStub,
  createFetchRateLimitStub,
  type DurableObjectStubLike,
} from './realPorts.js'
import { EnvSecretProvider, type SecretMaterialMap, type CurrentKeyByClient } from './secrets.js'
import { createOidcVerifier, type OidcConfig, type OidcVerifier } from '@smithy-hono/security-core'

/**
 * The minimal structural view of a Durable Object namespace binding the stores
 * need: `idFromName(key)` routes a key to its serial object, and `get(id)`
 * returns a stub the adapter drives over `fetch`.
 */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown
  get(id: unknown): DurableObjectStubLike
}

/** The bindings {@link createCloudflareSecurityStores} reads off the Worker `env`. */
export interface CloudflareSecurityBindings {
  /** Workers KV namespace backing the session store (eventual consistency OK). */
  SESSIONS: KvNamespaceLike
  /** Durable Object namespace backing the rate-limit + nonce stores (strong). */
  SECURITY_DO: DurableObjectNamespaceLike
}

export interface CloudflareSecurityStoresOptions {
  /**
   * S2S HMAC signing material: `keyId → hex-encoded key` and the current keyId
   * per client. Omit when the service serves no signed (sigv4Hmac) operation —
   * then `secrets` is returned `undefined`. The material MUST be lowercase hex
   * (see {@link EnvSecretProvider}); a deploy tool that mints base64 keys must
   * convert before binding the secret.
   */
  secrets?: { material: SecretMaterialMap; currentByClient: CurrentKeyByClient }
}

/**
 * Wire the canonical security stores from a Worker `env`. Returns `session`,
 * `nonce`, and `rateLimit` always (built from `SESSIONS` + `SECURITY_DO`), and
 * `secrets` when {@link CloudflareSecurityStoresOptions.secrets} is supplied.
 * Destructure exactly the stores your `PipelineConfig` declares.
 */
export function createCloudflareSecurityStores(
  env: CloudflareSecurityBindings,
  options: CloudflareSecurityStoresOptions = {},
) {
  const session = new KvSessionStore(env.SESSIONS)
  // Route each KEY to the object that owns it via `idFromName(key)` so a single
  // bucket / nonce lives on a single serial object (strong consistency).
  const nonce = new DurableNonceStore((n) =>
    createFetchNonceStub(env.SECURITY_DO.get(env.SECURITY_DO.idFromName(n))),
  )
  const rateLimit = new DurableRateLimitStore((key) =>
    createFetchRateLimitStub(env.SECURITY_DO.get(env.SECURITY_DO.idFromName(key))),
  )
  const secrets = options.secrets
    ? new EnvSecretProvider(options.secrets.material, options.secrets.currentByClient)
    : undefined
  return { session, nonce, rateLimit, secrets }
}

/**
 * Build a memoized OIDC verifier getter for a Worker. `createOidcVerifier` does
 * a discovery `fetch` at construction; Workers forbid network during module
 * initialization, so the verifier MUST be built lazily on first request, not at
 * module top level. Hold the returned getter at module scope and call it
 * per-request — it builds the verifier once and caches the promise:
 *
 * ```ts
 * let getVerifier: (() => Promise<OidcVerifier>) | undefined
 * // inside fetch():
 * getVerifier ??= lazyOidcVerifier({ issuer: env.OIDC_ISSUER, audience: env.OIDC_CLIENT_ID })
 * const verifier = await getVerifier()
 * ```
 */
export function lazyOidcVerifier(config: OidcConfig): () => Promise<OidcVerifier> {
  let cached: Promise<OidcVerifier> | undefined
  return () => {
    if (!cached) {
      // Cache the SUCCESS only. `createOidcVerifier` awaits a discovery `fetch`
      // when configured with just an `issuer`; a transient failure there must NOT
      // be cached, or `??=` would pin the settled-rejected promise for the whole
      // isolate lifetime (a permanent auth outage). Clear on rejection so the next
      // call retries.
      cached = createOidcVerifier(config).catch((err) => {
        cached = undefined
        throw err
      })
    }
    return cached
  }
}
