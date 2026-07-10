/**
 * Shared, reusable storage conformance suites (ARCH-03).
 *
 * Any implementation of a storage interface — the dev in-memory ones here, and
 * the Phase S10 adapters (Durable Objects / Redis / DynamoDB-CAS) — MUST pass
 * the matching suite. Adapters import these `describe*` factories and call them
 * against a freshly-constructed store; that's how we keep behavioral parity
 * across backends.
 *
 * The {@link describeRateLimitStore} and {@link describeNonceStore} suites
 * include strong-consistency assertions (read-after-write, no-overspend,
 * exactly-once acceptance under concurrency). The in-memory stores satisfy these
 * because each `await` body runs to completion without interleaving; real
 * backends must provide the equivalent atomicity (docs 00, 07, 08).
 *
 * This file imports only `vitest` (a Web-standard-agnostic test runner) — no
 * `node:*` (ARCH-01).
 */

import { describe, it, expect } from 'vitest'
import type {
  NonceStore,
  Principal,
  RateLimitStore,
  SessionRecord,
  SessionStore,
} from './index.js'

/** A store factory: returns a fresh, isolated instance per test. */
export type Factory<T> = () => T | Promise<T>

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

function principal(id: string): Principal {
  return { id, permissions: [], claims: {}, kind: 'user' }
}

function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = Date.now()
  return {
    principal: principal('user-1'),
    createdAt: now,
    absoluteExpiry: now + 60 * 60 * 1000,
    csrfToken: 'csrf-token-abc',
    claims: {},
    ...overrides,
  }
}

// ===========================================================================
// SessionStore
// ===========================================================================

export function describeSessionStore(name: string, factory: Factory<SessionStore>): void {
  describe(`SessionStore conformance: ${name}`, () => {
    it('returns null for an unknown session', async () => {
      const store = await factory()
      expect(await store.get('missing')).toBeNull()
    })

    it('round-trips a record (read-after-write)', async () => {
      const store = await factory()
      const rec = sessionRecord()
      await store.set('s1', rec, 60)
      const got = await store.get('s1')
      expect(got).not.toBeNull()
      expect(got!.principal.id).toBe('user-1')
      expect(got!.csrfToken).toBe('csrf-token-abc')
      expect(got!.absoluteExpiry).toBe(rec.absoluteExpiry)
    })

    it('delete revokes immediately (AUTH-04) and is idempotent', async () => {
      const store = await factory()
      await store.set('s1', sessionRecord(), 60)
      await store.delete('s1')
      expect(await store.get('s1')).toBeNull()
      await store.delete('s1') // idempotent
      expect(await store.get('s1')).toBeNull()
    })

    it('expires after the idle TTL lapses (AUTH-05)', async () => {
      const store = await factory()
      await store.set('s1', sessionRecord(), 0.05) // 50ms idle TTL
      expect(await store.get('s1')).not.toBeNull()
      await wait(80)
      expect(await store.get('s1')).toBeNull()
    })

    it('touch slides the idle TTL (AUTH-05)', async () => {
      const store = await factory()
      await store.set('s1', sessionRecord(), 0.1)
      await wait(60)
      await store.touch('s1', 0.2) // slide forward
      await wait(80) // past the original 100ms, within the slid 200ms
      expect(await store.get('s1')).not.toBeNull()
    })

    it('never revives past the absolute expiry, even when touched (AUTH-05)', async () => {
      const store = await factory()
      const rec = sessionRecord({ absoluteExpiry: Date.now() + 40 })
      await store.set('s1', rec, 60) // long idle TTL...
      await wait(70) // ...but absolute cap has passed
      await store.touch('s1', 60)
      expect(await store.get('s1')).toBeNull()
    })

    it('touch on a missing session is a no-op', async () => {
      const store = await factory()
      await store.touch('missing', 60) // must not throw
      expect(await store.get('missing')).toBeNull()
    })
  })
}

// ===========================================================================
// RateLimitStore — includes strong-consistency / no-overspend checks
// ===========================================================================

export function describeRateLimitStore(
  name: string,
  factory: Factory<RateLimitStore>,
): void {
  describe(`RateLimitStore conformance: ${name}`, () => {
    const spec = { capacity: 5, refillPerSecond: 1 }

    it('allows up to capacity then denies (read-after-write accounting)', async () => {
      const store = await factory()
      for (let i = 0; i < 5; i++) {
        const d = await store.consume('k', 1, spec)
        expect(d.allowed).toBe(true)
        expect(d.remaining).toBe(5 - (i + 1))
      }
      const denied = await store.consume('k', 1, spec)
      expect(denied.allowed).toBe(false)
      expect(denied.remaining).toBe(0)
      expect(denied.retryAfterSeconds).toBeGreaterThan(0)
    })

    it('keys are independent', async () => {
      const store = await factory()
      for (let i = 0; i < 5; i++) await store.consume('a', 1, spec)
      const other = await store.consume('b', 1, spec)
      expect(other.allowed).toBe(true)
      expect(other.remaining).toBe(4)
    })

    it('honors per-call cost (RATE-07)', async () => {
      const store = await factory()
      const d = await store.consume('k', 3, spec)
      expect(d.allowed).toBe(true)
      expect(d.remaining).toBe(2)
      const denied = await store.consume('k', 3, spec) // only 2 left
      expect(denied.allowed).toBe(false)
      expect(denied.remaining).toBe(2) // unchanged on denial
    })

    it('refills over time', async () => {
      const store = await factory()
      for (let i = 0; i < 5; i++) await store.consume('k', 1, spec)
      expect((await store.consume('k', 1, spec)).allowed).toBe(false)
      await wait(1100) // ~1 token back at 1/sec
      expect((await store.consume('k', 1, spec)).allowed).toBe(true)
    })

    it('does NOT overspend under concurrent consume (strong consistency)', async () => {
      // 20 concurrent single-token requests against a capacity-5 bucket.
      // A strongly-consistent store grants exactly 5 — no cross-call race.
      const store = await factory()
      const results = await Promise.all(
        Array.from({ length: 20 }, () => store.consume('hot', 1, spec)),
      )
      const granted = results.filter((r) => r.allowed).length
      expect(granted).toBe(5)
    })
  })
}

// ===========================================================================
// NonceStore — includes exactly-once / strong-consistency checks
// ===========================================================================

export function describeNonceStore(name: string, factory: Factory<NonceStore>): void {
  describe(`NonceStore conformance: ${name}`, () => {
    it('accepts a fresh nonce, rejects a replay (read-after-write)', async () => {
      const store = await factory()
      expect(await store.checkAndStore('n1', 60)).toBe(true)
      expect(await store.checkAndStore('n1', 60)).toBe(false)
    })

    it('distinct nonces are independent', async () => {
      const store = await factory()
      expect(await store.checkAndStore('a', 60)).toBe(true)
      expect(await store.checkAndStore('b', 60)).toBe(true)
    })

    it('accepts again only after the TTL window lapses', async () => {
      const store = await factory()
      expect(await store.checkAndStore('n', 0.05)).toBe(true)
      expect(await store.checkAndStore('n', 0.05)).toBe(false)
      await wait(80)
      expect(await store.checkAndStore('n', 0.05)).toBe(true)
    })

    it('accepts a given nonce EXACTLY once under concurrency (strong consistency)', async () => {
      // 25 concurrent checks of the same nonce → exactly one acceptance.
      const store = await factory()
      const results = await Promise.all(
        Array.from({ length: 25 }, () => store.checkAndStore('race', 60)),
      )
      const accepted = results.filter((ok) => ok).length
      expect(accepted).toBe(1)
    })
  })
}
