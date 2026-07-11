/**
 * Run the security-core storage conformance suites against the AWS DynamoDB
 * stores backed by the in-process FAKE port. The fake provides the same
 * conditional/CAS atomicity DynamoDB does, so passing here proves the store
 * logic (key namespacing, ttl/expiry handling, CAS refill, first-write-wins)
 * is correct — including the no-overspend and exactly-once strong-consistency
 * assertions.
 *
 * The real DynamoDB CAS behavior (true concurrent writers, ConditionalCheck
 * retries) is deferred to live-service CI (Part D); see README.
 */

import {
  describeSessionStore,
  describeRateLimitStore,
  describeNonceStore,
} from '@smithy-hono/security-core/storage/conformance'
import { FakeDynamoTablePort } from '../test-support.js'
import { DynamoSessionStore } from './session.js'
import { DynamoRateLimitStore } from './rateLimit.js'
import { DynamoNonceStore } from './nonce.js'

describeSessionStore('DynamoSessionStore (fake port)', () => new DynamoSessionStore(new FakeDynamoTablePort()))

describeRateLimitStore('DynamoRateLimitStore (fake port)', () => new DynamoRateLimitStore(new FakeDynamoTablePort()))

describeNonceStore('DynamoNonceStore (fake port)', () => new DynamoNonceStore(new FakeDynamoTablePort()))
