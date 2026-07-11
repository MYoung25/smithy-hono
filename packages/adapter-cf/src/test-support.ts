/**
 * In-process FAKES of the structural ports, for conformance + local testing.
 *
 * These honor the SAME atomicity contract as the real Cloudflare backends:
 *
 *   - {@link InMemoryDurableStorage} is a plain `Map` satisfying
 *     {@link DurableStorageLike}. Its `get`/`put` are async, so a DO operation's
 *     read-modify-write spans `await` points — exactly as on a real DO, where the
 *     storage API is async. A real Durable Object stays correct because Cloudflare
 *     processes requests to one object SERIALLY (one in flight at a time). The
 *     fake reproduces precisely that: {@link serializeStub} funnels every call
 *     through a single promise chain so one `consume`/`checkAndStore` runs to
 *     completion before the next begins. So the fake's strong-consistency
 *     guarantee == the DO's serial-execution guarantee (no read-stale-then-write
 *     race under `Promise.all`).
 *
 *   - {@link FakeKvNamespace} is a `Map`-backed {@link KvNamespaceLike} with
 *     synchronous TTL handling — a faithful stand-in for Workers KV minus the
 *     (irrelevant-to-correctness) eventual-consistency delay.
 *
 * NOT shipped for production use — exported via the `./test-support` subpath so
 * tests and `examples/` can build fake-backed stores. Production uses `realPorts`.
 */

import type {
  NonceDoStub,
  RateLimitDoStub,
  KvNamespaceLike,
  DurableStorageLike,
} from './ports.js'
import type {
  RateDecision,
  TokenBucketSpec,
} from '@smithy-hono/security-core/storage'
import { SecurityDurableObjectLogic } from './durableObject.js'

// ---------------------------------------------------------------------------
// Serial execution gate — models a Durable Object's one-request-at-a-time
// processing. Every operation is chained onto a single tail promise, so a
// read-modify-write that spans `await`s never interleaves with another. This is
// what makes the fake strongly consistent under `Promise.all`, mirroring the
// real DO's serial dispatch (NOT the bare microtask ordering of an async Map).
// ---------------------------------------------------------------------------

function serialize<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  let tail: Promise<unknown> = Promise.resolve()
  return (...args: A): Promise<R> => {
    const run = tail.then(() => fn(...args))
    // Keep the chain alive even if a call rejects; swallow on the gate copy only.
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

// ---------------------------------------------------------------------------
// Durable storage fake + DO-logic-backed stubs.
// ---------------------------------------------------------------------------

/** A `Map`-backed {@link DurableStorageLike}. Single-process, synchronous core. */
export class InMemoryDurableStorage implements DurableStorageLike {
  private readonly map = new Map<string, unknown>()
  /** The single armed alarm time (epoch millis), mirroring a real DO. */
  private alarmAt: number | null = null

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined
  }

  async put<T = unknown>(key: string, value: T): Promise<void> {
    this.map.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key)
  }

  /**
   * Prefix-scoped scan returning a key→value `Map`, matching
   * `DurableObjectStorage.list({ prefix })`. Lets the alarm sweep be exercised
   * in-process.
   */
  async list(opts?: { prefix?: string }): Promise<Map<string, unknown>> {
    const prefix = opts?.prefix ?? ''
    const out = new Map<string, unknown>()
    for (const [key, value] of this.map) {
      if (key.startsWith(prefix)) out.set(key, value)
    }
    return out
  }

  async setAlarm(scheduledTimeMs: number): Promise<void> {
    this.alarmAt = scheduledTimeMs
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt
  }
}

/**
 * A {@link RateLimitDoStub} that runs the real DO logic over an in-process Map.
 * Backs `DurableRateLimitStore` in conformance — same code path as production
 * minus the fetch hop.
 *
 * @param now optional clock injection for deterministic unit tests.
 */
export function createFakeRateLimitStub(now?: () => number): RateLimitDoStub {
  const logic = new SecurityDurableObjectLogic(new InMemoryDurableStorage(), now)
  const consume = serialize((key: string, cost: number, spec: TokenBucketSpec) =>
    logic.consume(key, cost, spec),
  )
  return { consume }
}

/**
 * A {@link NonceDoStub} that runs the real DO logic over an in-process Map.
 * Backs `DurableNonceStore` in conformance.
 */
export function createFakeNonceStub(now?: () => number): NonceDoStub {
  const logic = new SecurityDurableObjectLogic(new InMemoryDurableStorage(), now)
  const checkAndStore = serialize((nonce: string, ttlSeconds: number) =>
    logic.checkAndStore(nonce, ttlSeconds),
  )
  return { checkAndStore }
}

// ---------------------------------------------------------------------------
// KV fake.
// ---------------------------------------------------------------------------

interface KvEntry {
  value: string
  /** Epoch millis after which the entry is gone, or undefined for no TTL. */
  expiresAt?: number
}

/**
 * A `Map`-backed {@link KvNamespaceLike} honoring `expirationTtl` synchronously.
 * A faithful stand-in for Workers KV for store-logic tests (the SessionStore's
 * in-band absolute/idle guard is the authoritative eviction path regardless).
 */
export class FakeKvNamespace implements KvNamespaceLike {
  private readonly map = new Map<string, KvEntry>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  async get(key: string): Promise<string | null> {
    const entry = this.map.get(key)
    if (!entry) return null
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.map.delete(key)
      return null
    }
    return entry.value
  }

  async put(
    key: string,
    value: string,
    opts?: { expirationTtl?: number },
  ): Promise<void> {
    const expiresAt =
      opts?.expirationTtl !== undefined
        ? this.now() + opts.expirationTtl * 1000
        : undefined
    this.map.set(key, { value, expiresAt })
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key)
  }

  /**
   * `KVNamespace.list` — prefix-scoped keys with native opaque-cursor
   * pagination. Backs the KV {@link import('./dataStore.js').createKvDataStore}
   * conformance (the session stores don't list). The cursor is an opaque base64
   * of the last key returned (never an offset), matching real KV's contract;
   * expired entries are skipped (and reaped) so listing honors idle-TTL.
   */
  async list(opts?: {
    prefix?: string
    limit?: number
    cursor?: string
  }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }> {
    const prefix = opts?.prefix ?? ''
    const limit = opts?.limit ?? 1000
    const after =
      opts?.cursor !== undefined
        ? decodeURIComponent(escape(atob(opts.cursor)))
        : undefined
    const now = this.now()
    const all = Array.from(this.map.entries())
      .filter(([name, entry]) => {
        if (!name.startsWith(prefix)) return false
        if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
          this.map.delete(name)
          return false
        }
        return true
      })
      .map(([name]) => name)
      .sort()
    const start = after !== undefined ? all.findIndex((n) => n > after) : 0
    const from = start < 0 ? all.length : start
    const slice = all.slice(from, from + limit)
    const complete = from + limit >= all.length
    const cursor =
      !complete && slice.length > 0
        ? btoa(unescape(encodeURIComponent(slice[slice.length - 1])))
        : undefined
    return {
      keys: slice.map((name) => ({ name })),
      list_complete: complete,
      ...(cursor !== undefined ? { cursor } : {}),
    }
  }
}
