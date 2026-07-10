/**
 * DynamoDB-backed {@link RateLimitStore} (RATE-01/07) — STRONGLY CONSISTENT.
 *
 * The mandate (plan 11, docs 00 & 08): a single logical bucket MUST NOT
 * overspend across concurrent callers. We achieve that with optimistic
 * concurrency: read the bucket item `{tokens,lastRefillMs,version}`, run the
 * pure {@link computeTokenBucket} math, and write back conditional on the
 * `version` being unchanged. On a version conflict the port returns `false` and
 * we RETRY (bounded) — re-reading the now-current state. Under DynamoDB's
 * strongly-consistent conditional writes this yields exact RATE-01 limits with
 * no cross-caller race (conformance: 20 concurrent consumes on a cap-5 bucket
 * grant exactly 5).
 *
 * Keyed `rl:<key>`. The bucket item also carries a `ttl` so idle buckets are
 * reclaimed; the ttl is slid forward to "now + time-to-full" on every write.
 */

import type {
  RateDecision,
  RateLimitStore,
  TokenBucketSpec,
} from '@smithy-hono/security-core/storage'
import type { DynamoTablePort } from '../port.js'
import { TTL_ATTR } from '../port.js'
import { computeTokenBucket, type BucketState } from '../tokenBucket.js'

const nowMs = (): number => Date.now()

const keyFor = (key: string): { pk: string } => ({ pk: `rl:${key}` })

/** Bounded CAS retries before giving up under sustained contention. */
const MAX_CAS_RETRIES = 16

/**
 * Ceiling (millis) on the elapsed time a single `consume` may credit. DynamoDB
 * has no server clock inside a conditional write, so a logical bucket shared by
 * horizontally-scaled callers is governed by each caller's own `Date.now()`. A
 * wildly-fast/skewed caller could otherwise credit a huge `elapsed` and overspend
 * past the limit. Capping the per-step elapsed (and never moving `lastRefillMs`
 * backward, below) makes refill robust to clock skew: one skew episode can at most
 * refill a bucket fully (clamped to capacity), bounded, instead of unbounded.
 */
const MAX_ELAPSED_MS = 60 * 60 * 1000 // 1 hour — long enough to refill any sane bucket.

export class DynamoRateLimitStore implements RateLimitStore {
  constructor(private readonly port: DynamoTablePort) {}

  async consume(key: string, cost: number, limit: TokenBucketSpec): Promise<RateDecision> {
    const k = keyFor(key)
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      // `decision` is captured from inside the mutate closure that the port runs
      // against the freshly-read current state, so it always reflects the state
      // we actually commit on.
      let decision: RateDecision | undefined
      const committed = await this.port.updateConditional(k, (current) => {
        const prior = readState(current)
        // Skew-robust clock: never move `lastRefillMs` backward (a slow caller
        // must not rewind the bucket) and never credit more than MAX_ELAPSED_MS
        // of refill in one step (a fast/skewed caller must not over-credit). This
        // bounds a clock-skew episode to at most one full refill instead of an
        // unbounded overspend, since there is no DynamoDB server clock to source.
        const skewSafeNow = clampNow(nowMs(), prior)
        const { decision: d, next } = computeTokenBucket(prior, cost, limit, skewSafeNow)
        decision = d
        // Slide ttl to when the bucket would be full again (bounded; never 0).
        const ttlSeconds =
          limit.refillPerSecond > 0
            ? Math.ceil((next.tokens === limit.capacity ? 0 : (limit.capacity - next.tokens) / limit.refillPerSecond))
            : 3600
        return {
          ...k,
          tokens: next.tokens,
          lastRefillMs: next.lastRefillMs,
          [TTL_ATTR]: Math.floor(nowMs() / 1000) + Math.max(60, ttlSeconds),
        }
      })
      if (committed && decision) return decision
      // CAS miss → re-read and recompute on the next loop iteration.
    }
    // Contention budget exhausted: fail safe by denying (do not overspend).
    const { decision } = computeTokenBucket(null, cost, limit, nowMs())
    return { ...decision, allowed: false, remaining: 0 }
  }
}

/**
 * Clamp a caller-supplied `now` to be skew-robust against the bucket's prior
 * `lastRefillMs`: never earlier than the prior refill (no backward rewind), and
 * never further ahead than `MAX_ELAPSED_MS` past it (cap the credited elapsed).
 * A fresh bucket (no prior) is left as-is.
 */
function clampNow(now: number, prior: BucketState | null): number {
  if (!prior) return now
  const floor = prior.lastRefillMs
  const ceil = prior.lastRefillMs + MAX_ELAPSED_MS
  return Math.min(Math.max(now, floor), ceil)
}

function readState(item: Record<string, unknown> | null): BucketState | null {
  if (!item) return null
  const tokens = item.tokens
  const lastRefillMs = item.lastRefillMs
  if (typeof tokens !== 'number' || typeof lastRefillMs !== 'number') return null
  return { tokens, lastRefillMs }
}
