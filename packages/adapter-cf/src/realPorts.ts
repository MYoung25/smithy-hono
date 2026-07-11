/**
 * REAL port implementations — production wiring over the structural platform
 * types. None of this imports a Cloudflare SDK; the consumer's real bindings
 * structurally satisfy the `*Like` shapes.
 *
 *   - {@link createFetchRateLimitStub} / {@link createFetchNonceStub}: turn a
 *     `DurableObjectStub`-like handle (anything with `fetch(Request): Promise<Response>`)
 *     into the {@link RateLimitDoStub} / {@link NonceDoStub} the stores expect,
 *     serializing the call over the {@link DO_PATHS} HTTP contract.
 */

import type {
  RateDecision,
  TokenBucketSpec,
} from '@smithy-hono/security-core/storage'
import type { NonceDoStub, RateLimitDoStub } from './ports.js'
import { DO_PATHS } from './durableObject.js'

/**
 * The slice of a Cloudflare `DurableObjectStub` we use: a `fetch` that takes a
 * `Request` and returns a `Response`. The real stub returned by
 * `env.SECURITY_DO.get(id)` is a structural superset.
 */
export interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>
}

/**
 * The base URL is irrelevant for a DO stub fetch (the stub ignores the host and
 * routes to its object), but a well-formed absolute URL is required to construct
 * `Request`. This sentinel makes the `URL` parse cleanly.
 */
const DO_ORIGIN = 'https://do.internal'

async function postJson(
  stub: DurableObjectStubLike,
  path: string,
  body: unknown,
): Promise<unknown> {
  const res = await stub.fetch(
    new Request(DO_ORIGIN + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  if (!res.ok) {
    throw new Error(`SecurityDurableObject ${path} failed: HTTP ${res.status}`)
  }
  return res.json()
}

/**
 * Wrap a DO stub as a {@link RateLimitDoStub}. POSTs `{ key, cost, spec }` to
 * `/consume` and parses the returned {@link RateDecision}.
 */
export function createFetchRateLimitStub(stub: DurableObjectStubLike): RateLimitDoStub {
  return {
    async consume(
      key: string,
      cost: number,
      spec: TokenBucketSpec,
    ): Promise<RateDecision> {
      const wire = (await postJson(stub, DO_PATHS.consume, { key, cost, spec })) as RateDecision
      // Decode the -1 sentinels the DO uses for non-finite (never-refill)
      // resetAt / retryAfterSeconds back into Infinity (see durableObject.ts).
      return {
        ...wire,
        resetAt: wire.resetAt < 0 ? Infinity : wire.resetAt,
        retryAfterSeconds: wire.retryAfterSeconds < 0 ? Infinity : wire.retryAfterSeconds,
      }
    },
  }
}

/**
 * Wrap a DO stub as a {@link NonceDoStub}. POSTs `{ nonce, ttlSeconds }` to
 * `/check-and-store` and parses `{ accepted }`.
 */
export function createFetchNonceStub(stub: DurableObjectStubLike): NonceDoStub {
  return {
    async checkAndStore(nonce: string, ttlSeconds: number): Promise<boolean> {
      const out = (await postJson(stub, DO_PATHS.checkAndStore, {
        nonce,
        ttlSeconds,
      })) as { accepted: boolean }
      return out.accepted
    },
  }
}
