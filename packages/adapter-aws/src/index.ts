/**
 * `@smithy-hono/adapter-aws` — AWS runtime adapter for `@smithy-hono/security-core`.
 *
 * Implements the four storage interfaces against AWS backends (DynamoDB for the
 * stores, Secrets Manager for signing keys) plus the platform glue (forwarded-
 * proto / client-IP resolvers, CloudWatch console logger). Stores depend only on
 * a narrow structural {@link DynamoTablePort}; the real port speaks to DynamoDB
 * through a structural client, so this package neither imports nor requires
 * `@aws-sdk/*` to typecheck or test (ARCH-01).
 *
 * Rate-limit and nonce stores are STRONGLY CONSISTENT via DynamoDB conditional
 * writes / optimistic-concurrency CAS (plan 11 mandate).
 */

// --- The port abstraction ---
export type { DynamoTablePort, ItemKey } from './port.js'
export { PK_ATTR, TTL_ATTR, VERSION_ATTR } from './port.js'

// --- Real DynamoDB port (structural client; no SDK import) ---
export { createDynamoTablePort } from './dynamoPort.js'
export type { DynamoSendLike } from './dynamoPort.js'

// --- The four storage implementations ---
export { DynamoSessionStore } from './stores/session.js'
export { DynamoRateLimitStore } from './stores/rateLimit.js'
export { DynamoNonceStore } from './stores/nonce.js'
export { SecretsManagerSecretProvider } from './secrets.js'
export type {
  SecretsSourceLike,
  DynamoSecretProviderOptions,
} from './secrets.js'

// --- Key lifecycle backend (OPS-03) — full provision/rotate/revoke via Secrets
//     Manager (writable) + a directory port (e.g. DynamoDB). -------------------
export { AwsKeyBackend } from './secrets.js'
export type {
  WritableSecretsSourceLike,
  KeyDirectoryPortLike,
  AwsKeyDirectoryEntry,
  AwsKeyBackendOptions,
} from './secrets.js'

// --- DataStore<T> (Plan 13 P6) — DynamoDB-backed, full-featured ---------------
//     A SEPARATE table from the security store (a `pk`/`sk` schema for scoped,
//     ordered list + GSIs for declared `@persisted(indexes)`); strong-consistency
//     version-CAS via conditional writes, opaque-cursor pagination
//     (LastEvaluatedKey), count via `Select: 'COUNT'`. See dataStore.ts.
export {
  createDynamoDataStore,
  createDynamoDataPort,
  createFakeDynamoDataPort,
  describeDataTable,
  DynamoDataStore,
  DDB_DATA_TABLE_DEFAULT,
  DATA_PK_ATTR,
  DATA_SK_ATTR,
  DATA_VERSION_ATTR,
  DATA_DELETED_AT_ATTR,
  type DynamoDataPort,
  type DynamoDataStoreOptions,
  type DynamoRow,
  type DynamoListArgs,
  type DynamoTableSchema,
  type DynamoGsiSchema,
} from './dataStore.js'

// --- Shared pure math (unit-testable; used by real + fake paths) ---
export { computeTokenBucket } from './tokenBucket.js'
export type { BucketState, BucketResult } from './tokenBucket.js'

// --- Platform glue ---
export { awsForwardedProto, awsClientIp, createConsoleLogger } from './glue.js'

// --- Concrete audit + metrics sinks (OPS-05, LOG-08/10) — console → CloudWatch ---
export {
  createConsoleAuditSink,
  createConsoleMetricsSink,
  type ConsoleSinkOptions,
  type LogSink,
} from './auditSink.js'
