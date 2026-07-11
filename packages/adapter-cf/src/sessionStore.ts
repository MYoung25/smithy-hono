/**
 * {@link SessionStore} over Workers KV (plan/security/11 Part B).
 *
 * SessionRecord is stored as JSON under the session ID. Idle-TTL eviction uses
 * KV's native `put({ expirationTtl })`; `touch` re-puts the same value with a
 * fresh `expirationTtl` (KV has no in-place touch). The absolute-expiry ceiling
 * (AUTH-05) is enforced in-band on read/touch — it can lie before the KV TTL, so
 * we honor it explicitly rather than relying on TTL alone.
 *
 * CONSISTENCY: Workers KV is eventually consistent (a write can take up to ~60s
 * to be globally visible). This is ACCEPTED for sessions per the plan: a session
 * lookup that briefly misses a just-minted session degrades to a re-auth, not a
 * security failure, and revocation latency is bounded by the same window — for
 * hard, immediate revocation across all PoPs a deployment can additionally key a
 * Durable Object, but that is out of scope here. Rate-limit and nonce do NOT use
 * KV (they require strong consistency → Durable Objects).
 */

import type {
  SessionRecord,
  SessionStore,
} from '@smithy-hono/security-core/storage'
import type { KvNamespaceLike } from './ports.js'

/** What we actually serialize into KV: the record plus its absolute-expiry guard. */
interface StoredSession {
  rec: SessionRecord
  /** Mirror of `rec.absoluteExpiry`; kept top-level for a cheap guard read. */
  absoluteExpiry: number
}

/**
 * KV is keyed flat; namespace session keys so they never collide with other data
 * a deployment might keep in the same KV namespace.
 */
const KEY_PREFIX = 'sess:'

/** Minimum KV `expirationTtl` is 60s; clamp up so sub-minute idle TTLs still set. */
const KV_MIN_TTL_SECONDS = 60

export class KvSessionStore implements SessionStore {
  constructor(
    private readonly kv: KvNamespaceLike,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private key(sessionId: string): string {
    return KEY_PREFIX + sessionId
  }

  /**
   * KV requires `expirationTtl >= 60`. For shorter idle windows we still set 60s
   * at the KV layer and let the in-band absolute-expiry / idle-expiry guard do the
   * fine-grained eviction on read. (Conformance uses sub-second TTLs; the in-band
   * guard is what makes those pass — see `expiresAt`.)
   */
  private kvTtl(ttlSeconds: number): number {
    return Math.max(KV_MIN_TTL_SECONDS, Math.ceil(ttlSeconds))
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    const raw = await this.kv.get(this.key(sessionId))
    if (raw === null) return null
    const stored = JSON.parse(raw) as StoredSession & { expiresAt?: number }
    const now = this.now()
    // In-band idle-TTL + absolute-expiry guard (AUTH-05). KV TTL is a backstop;
    // this is the authoritative check (and the only one fine-grained enough for
    // sub-minute idle windows).
    if (
      (stored.expiresAt !== undefined && stored.expiresAt <= now) ||
      stored.absoluteExpiry <= now
    ) {
      await this.kv.delete(this.key(sessionId))
      return null
    }
    return stored.rec
  }

  async set(
    sessionId: string,
    rec: SessionRecord,
    ttlSeconds: number,
  ): Promise<void> {
    const stored: StoredSession & { expiresAt: number } = {
      rec,
      absoluteExpiry: rec.absoluteExpiry,
      expiresAt: this.now() + ttlSeconds * 1000,
    }
    await this.kv.put(this.key(sessionId), JSON.stringify(stored), {
      expirationTtl: this.kvTtl(ttlSeconds),
    })
  }

  async delete(sessionId: string): Promise<void> {
    await this.kv.delete(this.key(sessionId))
  }

  async touch(sessionId: string, idleTtlSeconds: number): Promise<void> {
    const raw = await this.kv.get(this.key(sessionId))
    if (raw === null) return // no-op on missing session
    const stored = JSON.parse(raw) as StoredSession & { expiresAt?: number }
    const now = this.now()
    // Never revive past the absolute ceiling (AUTH-05).
    if (stored.absoluteExpiry <= now) {
      await this.kv.delete(this.key(sessionId))
      return
    }
    const next: StoredSession & { expiresAt: number } = {
      rec: stored.rec,
      absoluteExpiry: stored.absoluteExpiry,
      expiresAt: now + idleTtlSeconds * 1000,
    }
    await this.kv.put(this.key(sessionId), JSON.stringify(next), {
      expirationTtl: this.kvTtl(idleTtlSeconds),
    })
  }
}
