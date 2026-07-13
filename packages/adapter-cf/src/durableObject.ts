/**
 * The security Durable Object — the strongly-consistent backend for the
 * rate-limit and nonce stores (plan/security/11 Part B: DOs are REQUIRED for
 * both; KV is not accepted).
 *
 * Why a DO gives strong consistency: Cloudflare runs each Durable Object
 * SINGLE-THREADED and processes requests to it SERIALLY. A read-modify-write that
 * spans several `await storage.get(...)` / `storage.put(...)` calls therefore
 * executes atomically with respect to every other request to the SAME object —
 * which is precisely the guarantee the in-process Map fake reproduces (it runs
 * each async body to completion without interleaving). Same logic, same backend
 * shape ({@link DurableStorageLike}), same atomicity.
 *
 * This file holds only the *logic* over the structural storage port. The fetch()
 * wiring (request/response shape) lives in `realPorts.ts`; the in-process fake
 * lives in `test-support.ts`. Both drive the methods below.
 */

import type { RateDecision, TokenBucketSpec } from '@smithy-hono/security-core/storage'
import type { DurableStorageLike } from './ports.js'
import { computeTokenBucket, type BucketState } from './tokenBucket.js'

/** Storage key prefixes within a single DO so buckets and nonces never collide. */
const RL_PREFIX = 'rl:'
const NONCE_PREFIX = 'nonce:'

/**
 * How far ahead to arm the reclamation alarm when a record is written. The sweep
 * is a coarse janitor, not a precise per-record timer: a record is only ever
 * read past `expiresAt` (lazy expiry) or deleted by this sweep, so the exact
 * cadence only affects how promptly storage is reclaimed, not correctness.
 */
const SWEEP_INTERVAL_MS = 60 * 1000

/** Any record with an `expiresAt` (both nonce and bucket entries carry one). */
interface ExpiringEntry {
  expiresAt: number
}

/** Stored nonce record: the epoch-millis expiry. */
interface NonceEntry {
  expiresAt: number
}

/**
 * Stored rate-limit record: the token-bucket {@link BucketState} plus the
 * epoch-millis time the bucket would be full again. `expiresAt` is purely for
 * reclamation — a record past it is indistinguishable from a fresh (full) bucket,
 * so it is treated as absent on read (lazy expiry) and is the eviction key an
 * {@link https://developers.cloudflare.com/durable-objects/api/alarms/ alarm}
 * sweep would target.
 */
interface BucketEntry extends BucketState {
  expiresAt: number
}

/**
 * The atomic security operations, factored out of any platform `DurableObject`
 * base class so they can run over either a real `DurableObjectStorage` or the
 * in-process fake. {@link SecurityDurableObject} and the fake both delegate here.
 */
export class SecurityDurableObjectLogic {
  constructor(
    private readonly storage: DurableStorageLike,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Atomic token-bucket consume (RATE-01/07). Reads the bucket state, applies the
   * pure {@link computeTokenBucket} math, persists the next state, returns the
   * decision. Serial DO execution makes the read→compute→write indivisible, so
   * concurrent consumes against one key cannot overspend.
   */
  async consume(
    key: string,
    cost: number,
    spec: TokenBucketSpec,
  ): Promise<RateDecision> {
    const storageKey = RL_PREFIX + key
    const now = this.now()
    const stored = await this.storage.get<BucketEntry>(storageKey)
    // Lazy expiry: a record past `expiresAt` (idle long enough to have refilled to
    // capacity) is indistinguishable from a fresh bucket, so treat it as absent.
    // This bounds storage for revisited keys and backstops the alarm sweep.
    const prev = stored !== undefined && stored.expiresAt > now ? stored : undefined
    const { decision, state } = computeTokenBucket(prev, cost, spec, now)
    // Persist the next state with the time the bucket would be full again, so the
    // record self-expires (lazily here, actively via the alarm sweep) once idle.
    const ttlSeconds =
      spec.refillPerSecond > 0
        ? Math.max(1, Math.ceil((spec.capacity - state.tokens) / spec.refillPerSecond))
        : 24 * 60 * 60
    const entry: BucketEntry = { ...state, expiresAt: now + ttlSeconds * 1000 }
    await this.storage.put<BucketEntry>(storageKey, entry)
    await this.ensureSweepArmed(now)
    return decision
  }

  /**
   * Atomic first-write-wins nonce check (SIGN-03/10). Returns `true` and records
   * the nonce iff it was unseen (or its prior entry has expired); returns `false`
   * for a replay within the TTL window. Serial DO execution makes this
   * exactly-once under concurrency.
   */
  async checkAndStore(nonce: string, ttlSeconds: number): Promise<boolean> {
    const storageKey = NONCE_PREFIX + nonce
    const now = this.now()
    const existing = await this.storage.get<NonceEntry>(storageKey)
    if (existing !== undefined && existing.expiresAt > now) {
      return false // replay within window
    }
    await this.storage.put<NonceEntry>(storageKey, { expiresAt: now + ttlSeconds * 1000 })
    await this.ensureSweepArmed(now)
    return true
  }

  /**
   * Active reclamation (STORES-ATOMICITY-01/02). Lazy expiry alone only caps
   * storage for *revisited* keys; an attacker minting one-shot keys (rotating
   * IPs, unique nonces) never revisits them, so without this sweep the object
   * grows unbounded. Lists every `rl:`/`nonce:` record, deletes those whose
   * `expiresAt < now`, and re-arms itself while any record remains so an idle
   * object eventually drains to empty and stops re-arming.
   */
  async alarm(): Promise<void> {
    const now = this.now()
    let remaining = 0
    for (const prefix of [RL_PREFIX, NONCE_PREFIX]) {
      const entries = await this.storage.list({ prefix })
      for (const [key, value] of entries) {
        const expiresAt = (value as ExpiringEntry | undefined)?.expiresAt
        if (typeof expiresAt === 'number' && expiresAt < now) {
          await this.storage.delete(key)
        } else {
          remaining++
        }
      }
    }
    if (remaining > 0) {
      await this.storage.setAlarm(now + SWEEP_INTERVAL_MS)
    }
  }

  /**
   * (Re)arm the sweep alarm when a record is written, but only if no earlier
   * alarm is already pending — so a steady write stream doesn't keep pushing the
   * sweep further out, and the object always has a janitor scheduled.
   */
  private async ensureSweepArmed(now: number): Promise<void> {
    const existing = await this.storage.getAlarm()
    if (existing === null) {
      await this.storage.setAlarm(now + SWEEP_INTERVAL_MS)
    }
  }
}

// ---------------------------------------------------------------------------
// Worker-facing DO entrypoint: HTTP dispatch over the logic above.
// ---------------------------------------------------------------------------

/**
 * The request/response contract between the Worker-side stubs (`realPorts.ts`)
 * and this Durable Object. A single POST to one of these paths, JSON body in,
 * JSON decision out. Kept here so both ends share the shape.
 *
 *   POST /consume        { key, cost, spec } -> RateDecision
 *   POST /check-and-store { nonce, ttlSeconds } -> { accepted: boolean }
 */
export const DO_PATHS = {
  consume: '/consume',
  checkAndStore: '/check-and-store',
} as const

interface ConsumeRequestBody {
  key: string
  cost: number
  spec: TokenBucketSpec
}

interface CheckAndStoreRequestBody {
  nonce: string
  ttlSeconds: number
}

/**
 * The minimal `DurableObjectState`-like shape the DO entrypoint needs: just a
 * `storage` handle satisfying {@link DurableStorageLike}. The real Cloudflare
 * `DurableObjectState.storage` is a structural superset.
 */
export interface DurableObjectStateLike {
  storage: DurableStorageLike
}

/**
 * The deployable Durable Object class. A Cloudflare `export class
 * SecurityDurableObject extends ... {}` can simply subclass or delegate to this;
 * its only Cloudflare dependency is the structural `state.storage`. `fetch`
 * implements the {@link DO_PATHS} contract.
 *
 * Register in `wrangler.toml`:
 *   [[durable_objects.bindings]]
 *   name = "SECURITY_DO"
 *   class_name = "SecurityDurableObject"
 */
export class SecurityDurableObject {
  private readonly logic: SecurityDurableObjectLogic

  constructor(state: DurableObjectStateLike) {
    this.logic = new SecurityDurableObjectLogic(state.storage)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (url.pathname === DO_PATHS.consume) {
        const body = (await request.json()) as ConsumeRequestBody
        const decision = await this.logic.consume(body.key, body.cost, body.spec)
        // JSON.stringify turns Infinity into `null`, which would decode to a
        // 0-second Retry-After on the wire. Encode non-finite resetAt /
        // retryAfterSeconds as a -1 sentinel (mirroring the Redis Lua
        // convention in adapter-node/src/ports.ts) and decode in realPorts.ts.
        return Response.json({
          ...decision,
          resetAt: Number.isFinite(decision.resetAt) ? decision.resetAt : -1,
          retryAfterSeconds: Number.isFinite(decision.retryAfterSeconds)
            ? decision.retryAfterSeconds
            : -1,
        })
      }
      if (url.pathname === DO_PATHS.checkAndStore) {
        const body = (await request.json()) as CheckAndStoreRequestBody
        const accepted = await this.logic.checkAndStore(body.nonce, body.ttlSeconds)
        return Response.json({ accepted })
      }
      return new Response('Not Found', { status: 404 })
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : 'bad request' },
        { status: 400 },
      )
    }
  }

  /**
   * Cloudflare alarm callback. The runtime invokes this at the armed time; it
   * delegates to the logic's reclamation sweep (which re-arms while records
   * remain). Without this method the `setAlarm` writes would never fire.
   */
  async alarm(): Promise<void> {
    await this.logic.alarm()
  }
}
