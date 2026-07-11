/**
 * `@smithy-hono/adapter-node` — Node/Redis runtime adapter for
 * `@smithy-hono/security-core`.
 *
 * Implements the four storage interfaces (Session, RateLimit, Nonce,
 * SecretProvider) over a narrow structural {@link RedisPort}, plus the Node
 * platform glue (forwarded-proto / client-IP resolvers, stdout JSON logger). No
 * Redis SDK is imported at runtime: the real port maps onto a structural
 * {@link RedisClientLike} the consumer supplies (ARCH-01). Rate-limit and nonce
 * are strongly consistent via Redis atomic ops (Lua `EVAL` / `SET NX`).
 */

// Ports + structural client.
export {
  createRedisPort,
  type RedisPort,
  type RedisClientLike,
  type SetOptions,
} from './ports.js'

// Stores.
export {
  RedisSessionStore,
  RedisRateLimitStore,
  RedisNonceStore,
  type StoreOptions,
} from './stores.js'

// DataStore<T> (Plan 13 default CRUD) over Redis, behind a structural port.
export {
  createRedisDataStore,
  createRedisDataPort,
  createFakeRedisDataPort,
  RedisDataStore,
  type RedisDataPort,
  type RedisDataClientLike,
  type RedisDataStoreOptions,
} from './dataStore.js'

// Secrets (read path).
export {
  NodeSecretProvider,
  recordSecretSource,
  type SecretSourceLike,
  type NodeSecretProviderOptions,
  type HmacHash,
} from './secrets.js'

// Secrets — key LIFECYCLE write backend (OPS-03): provision / rotate / revoke.
export {
  RedisKeyBackend,
  redisSecretSource,
  type WritableKeyBackend,
  type KeyDirectoryEntry,
  type RedisKeyBackendOptions,
} from './secrets.js'
export { envSecretSource, type EnvSecretSourceOptions } from './secretsEnv.js'

// Platform glue.
export {
  forwardedProtoHeader,
  clientIp,
  clientIpResolver,
  createStdoutLogger,
  type ClientIpOptions,
  type StdoutLoggerOptions,
} from './glue.js'

// Concrete audit + metrics sinks (OPS-05, LOG-08/10) — stdout JSON → log shipper.
export {
  createStdoutAuditSink,
  createStdoutMetricsSink,
  type StdoutSinkOptions,
} from './auditSink.js'

// Pure token-bucket math (single source of truth; mirrored by the Lua script).
export {
  computeTokenBucket,
  bucketTtlMillis,
  TOKEN_BUCKET_LUA,
  type BucketState,
  type TokenBucketResult,
} from './tokenBucket.js'
