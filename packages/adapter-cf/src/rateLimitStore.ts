/**
 * {@link RateLimitStore} backed by the security Durable Object (strong, required).
 *
 * The store itself holds NO state — it forwards each `consume` to the DO via a
 * structural {@link RateLimitDoStub}. The atomicity (no-overspend under concurrent
 * consume) is provided entirely by the DO's serial execution; this class is just
 * the security-core-facing facade plus key routing.
 */

import type {
  RateDecision,
  RateLimitStore,
  TokenBucketSpec,
} from '@smithy-hono/security-core/storage'
import type { RateLimitDoStub } from './ports.js'

/**
 * Routes a limiter `key` to the Durable Object instance that owns its bucket.
 *
 * In production each distinct key should map to a stub for the DO derived from
 * `idFromName(key)` so a single bucket lives in a single object (that is what
 * makes it strongly consistent). The default router returns the one stub it was
 * given — suitable when the consumer pre-resolves the stub per request, or for
 * the in-process fake which has a single logical store.
 */
export type RateLimitStubRouter = (key: string) => RateLimitDoStub

export class DurableRateLimitStore implements RateLimitStore {
  private readonly route: RateLimitStubRouter

  constructor(stubOrRouter: RateLimitDoStub | RateLimitStubRouter) {
    this.route =
      typeof stubOrRouter === 'function'
        ? (stubOrRouter as RateLimitStubRouter)
        : () => stubOrRouter as RateLimitDoStub
  }

  async consume(
    key: string,
    cost: number,
    limit: TokenBucketSpec,
  ): Promise<RateDecision> {
    return this.route(key).consume(key, cost, limit)
  }
}
