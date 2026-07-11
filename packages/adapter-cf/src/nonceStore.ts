/**
 * {@link NonceStore} backed by the security Durable Object (strong, required).
 *
 * Stateless facade: each `checkAndStore` is forwarded to the DO via a structural
 * {@link NonceDoStub}. Exactly-once acceptance under concurrency is provided by
 * the DO's serial execution.
 */

import type { NonceStore } from '@smithy-hono/security-core/storage'
import type { NonceDoStub } from './ports.js'

/**
 * Routes a `nonce` to the Durable Object instance that owns it. In production
 * derive the DO from `idFromName(nonce)` (or a shard of it) so the same nonce
 * always lands on the same serial object. Default: the single given stub.
 */
export type NonceStubRouter = (nonce: string) => NonceDoStub

export class DurableNonceStore implements NonceStore {
  private readonly route: NonceStubRouter

  constructor(stubOrRouter: NonceDoStub | NonceStubRouter) {
    this.route =
      typeof stubOrRouter === 'function'
        ? (stubOrRouter as NonceStubRouter)
        : () => stubOrRouter as NonceDoStub
  }

  async checkAndStore(nonce: string, ttlSeconds: number): Promise<boolean> {
    return this.route(nonce).checkAndStore(nonce, ttlSeconds)
  }
}
