/**
 * `@smithy-hono/test-kit` — make testing a smithy-hono service ridiculously easy.
 *
 * Drive the GENERATED typed client against your generated router/pipeline in-process
 * (no network). Two harnesses:
 *   - {@link mountRouter}      — UNIT: router only, stand-in principal.
 *   - {@link createTestHarness} — INTEGRATION: full security pipeline + in-memory stores,
 *     with `loginAs` (cookie + CSRF) and `asService` (HMAC signing) helpers.
 *
 * Plus builders ({@link principal}, {@link sessionRecord}, {@link fakeContext}) and
 * runner-agnostic assertions ({@link expectError}, {@link expectStatus}).
 *
 * Web-standard only (ARCH-01) — runs in any test environment.
 */

export { inMemoryFetch } from './transport.js'
export type { FetchLike, AppLike, SignableRequest, InMemoryFetchOptions } from './transport.js'

export { principal, isPrincipal, sessionRecord, fakeContext } from './builders.js'
export type { PrincipalOptions, SessionOptions } from './builders.js'

export {
  createTestHarness,
  mountRouter,
  allPermissions,
  superuser,
} from './harness.js'
export type {
  ClientOptionsLike,
  ClientFactory,
  TestStores,
  HarnessOptions,
  Harness,
  AuthedClient,
  ServiceAuthOptions,
  MountOptions,
  MountedRouter,
} from './harness.js'

export {
  TestKitAssertionError,
  expectError,
  catchError,
  expectStatus,
} from './assert.js'

export { createMcpClient } from './mcp.js'
export type { McpClient, McpClientOptions, McpCallOptions, McpResponse } from './mcp.js'
