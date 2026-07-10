/**
 * `@smithy-hono/adapter-cf` — the Cloudflare runtime adapter for
 * `@smithy-hono/security-core` (Phase S10 Part B).
 *
 * Implements the four storage interfaces and the platform glue against
 * Cloudflare backends, over narrow structural ports so nothing here depends on a
 * Cloudflare SDK at runtime (ARCH-01):
 *
 *   - SessionStore   → Workers KV          ({@link KvSessionStore})
 *   - RateLimitStore → Durable Object      ({@link DurableRateLimitStore}, strong)
 *   - NonceStore     → Durable Object      ({@link DurableNonceStore}, strong)
 *   - SecretProvider → Workers env secrets ({@link EnvSecretProvider})
 *   - glue           → {@link forwardedProtoHeader}, {@link clientIp}, {@link createConsoleLogger}
 *
 * The deployable Durable Object class is {@link SecurityDurableObject}; the
 * Worker-side stubs are built with {@link createFetchRateLimitStub} /
 * {@link createFetchNonceStub}. In-process fakes for tests live in the
 * `@smithy-hono/adapter-cf/test-support` subpath.
 */

// --- Structural ports (the contract a consumer's bindings must satisfy) -----
export type {
  KvNamespaceLike,
  DurableStorageLike,
  RateLimitDoStub,
  NonceDoStub,
} from './ports.js'

// --- Stores -----------------------------------------------------------------
export { KvSessionStore } from './sessionStore.js'
export { DurableRateLimitStore, type RateLimitStubRouter } from './rateLimitStore.js'
export { DurableNonceStore, type NonceStubRouter } from './nonceStore.js'

// --- Durable Object (deployable) + its HTTP contract ------------------------
export {
  SecurityDurableObject,
  SecurityDurableObjectLogic,
  DO_PATHS,
  type DurableObjectStateLike,
} from './durableObject.js'

// --- Real port wiring (DO stubs over fetch) ---------------------------------
export {
  createFetchRateLimitStub,
  createFetchNonceStub,
  type DurableObjectStubLike,
} from './realPorts.js'

// --- Shared token-bucket math (single source of truth) ----------------------
export {
  computeTokenBucket,
  type BucketState,
  type TokenBucketResult,
} from './tokenBucket.js'

// --- Secret provider (read path) --------------------------------------------
export {
  EnvSecretProvider,
  type SecretMaterialMap,
  type CurrentKeyByClient,
} from './secrets.js'

// --- Key lifecycle backend (OPS-03) — directory plane writable; material plane
//     read-only (Workers secrets are provisioned out-of-band, see docs). --------
export {
  CfKeyBackend,
  type CfKeyDirectoryEntry,
  type KvDirectoryLike,
} from './secrets.js'

// --- DataStore<T> (Plan 13 P6) — D1 (full-featured) + KV (key-access subset) --
//     D1 is the strong-consistency, version-guarded write path (SQL CAS); KV is
//     the eventually-consistent subset that FAILS FAST on optimisticConcurrency.
//     Durable Objects are intentionally NOT a separate DataStore — D1 already
//     covers strong-consistency writes (see dataStore.ts).
export {
  createD1DataStore,
  createD1DataPort,
  createFakeD1DataPort,
  d1CreateTableSql,
  d1CreateIndexSql,
  D1_TABLE_DEFAULT,
  D1DataStore,
  type D1DataPort,
  type D1DataStoreOptions,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1Row,
  type D1ListArgs,
  createKvDataStore,
  KvDataStore,
  type KvDataStoreOptions,
  type KvListNamespaceLike,
} from './dataStore.js'

// --- Platform glue ----------------------------------------------------------
export { forwardedProtoHeader, clientIp, createConsoleLogger } from './glue.js'

// --- Reusable Worker-side store wiring (one call instead of the long-hand in
//     deploy/cf/src/worker.ts) + lazy OIDC verifier (no network at module init).
export {
  createCloudflareSecurityStores,
  lazyOidcVerifier,
  type CloudflareSecurityBindings,
  type CloudflareSecurityStoresOptions,
  type DurableObjectNamespaceLike,
} from './securityStores.js'

// --- Concrete audit + metrics sinks (OPS-05, LOG-08/10) — console → Logpush ---
export {
  createConsoleAuditSink,
  createConsoleMetricsSink,
  type ConsoleSinkOptions,
} from './auditSink.js'

// --- Realtime PUSH backend (Phase L4) — the CF Durable Object impl of the
//     `@smithy-hono/realtime` `RealtimeHub` port. A single STOCK, STATELESS DO
//     (`RealtimeDurableObject`) serves every `@live` resource, keyed by channelId;
//     `createDurableObjectHub` is the namespace-side notify/subscribe wiring.
export {
  RealtimeDurableObject,
  createDurableObjectHub,
  forwardLiveSubscribe,
  REALTIME_DO_PATHS,
  type RealtimeEvent,
  type RealtimeHub,
  type RealtimeDurableObjectStateLike,
} from './realtimeDurableObject.js'
export type { HibernationStateLike } from './ports.js'
