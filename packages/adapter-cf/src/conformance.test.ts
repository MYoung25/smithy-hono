/**
 * Runs the security-core storage conformance suites against the Cloudflare
 * adapter stores, each backed by the in-process fake ports (which run the SAME
 * DO logic / KV semantics as production). Passing these is the parity guarantee
 * across backends — including the strong-consistency assertions:
 *
 *   - RateLimitStore: no-overspend under 20 concurrent single-token consumes
 *     against a capacity-5 bucket (exactly 5 granted).
 *   - NonceStore: exactly-one acceptance under 25 concurrent checks of one nonce.
 */

import {
  describeSessionStore,
  describeRateLimitStore,
  describeNonceStore,
} from '@smithy-hono/security-core/storage/conformance'

import { KvSessionStore } from './sessionStore.js'
import { DurableRateLimitStore } from './rateLimitStore.js'
import { DurableNonceStore } from './nonceStore.js'
import {
  FakeKvNamespace,
  createFakeRateLimitStub,
  createFakeNonceStub,
} from './test-support.js'

describeSessionStore('KvSessionStore (FakeKvNamespace)', () => {
  return new KvSessionStore(new FakeKvNamespace())
})

describeRateLimitStore('DurableRateLimitStore (fake DO)', () => {
  // One fresh DO-logic-backed stub per store instance → isolated buckets.
  return new DurableRateLimitStore(createFakeRateLimitStub())
})

describeNonceStore('DurableNonceStore (fake DO)', () => {
  return new DurableNonceStore(createFakeNonceStub())
})
