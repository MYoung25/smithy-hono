/**
 * Run the security-core storage conformance suites against the Redis-backed
 * stores wired to the in-process FAKE port. The fake honors the same atomicity
 * contract as real Redis synchronously, so the strong-consistency assertions
 * (rate-limit no-overspend, nonce exactly-once) exercise the real store logic.
 * The Lua / SET-NX against a live server is validated separately in Part D CI.
 */

import {
  describeSessionStore,
  describeRateLimitStore,
  describeNonceStore,
} from '@smithy-hono/security-core/storage/conformance'
import { createFakeRedisPort } from './ports.js'
import {
  RedisSessionStore,
  RedisRateLimitStore,
  RedisNonceStore,
} from './stores.js'

describeSessionStore(
  'RedisSessionStore (fake port)',
  () => new RedisSessionStore(createFakeRedisPort()),
)

describeRateLimitStore(
  'RedisRateLimitStore (fake port)',
  () => new RedisRateLimitStore(createFakeRedisPort()),
)

describeNonceStore(
  'RedisNonceStore (fake port)',
  () => new RedisNonceStore(createFakeRedisPort()),
)
