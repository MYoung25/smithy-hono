/**
 * Focused tests for the Durable Object security logic — rate-limit bucket lazy
 * expiry (STORES-ATOMICITY-01/02). A bucket record carries an `expiresAt`; once
 * the bucket would be full again it is treated as absent on read, so a revisited
 * key never accumulates stale state and the record is reclaimable.
 */

import { describe, it, expect } from 'vitest'
import { SecurityDurableObjectLogic } from './durableObject.js'
import { InMemoryDurableStorage } from './test-support.js'
import type { TokenBucketSpec } from '@smithy-hono/security-core/storage'

describe('SecurityDurableObjectLogic.consume — lazy expiry', () => {
  const spec: TokenBucketSpec = { capacity: 5, refillPerSecond: 1 }

  it('treats a past-expiry bucket as a fresh (full) bucket on read', async () => {
    let now = 1_000_000
    const storage = new InMemoryDurableStorage()
    const logic = new SecurityDurableObjectLogic(storage, () => now)

    // Drain the bucket to empty.
    for (let i = 0; i < 5; i++) {
      expect((await logic.consume('k', 1, spec)).allowed).toBe(true)
    }
    expect((await logic.consume('k', 1, spec)).allowed).toBe(false)

    // Stored record carries an expiry in the future (time-to-full).
    const stored = await storage.get<{ expiresAt: number }>('rl:k')
    expect(stored).toBeDefined()
    expect(stored!.expiresAt).toBeGreaterThan(now)

    // Jump past the record's expiry → it is treated as absent → full bucket again.
    now = stored!.expiresAt + 1
    expect((await logic.consume('k', 1, spec)).allowed).toBe(true)
  })

  it('keeps refill semantics within the expiry window', async () => {
    let now = 2_000_000
    const storage = new InMemoryDurableStorage()
    const logic = new SecurityDurableObjectLogic(storage, () => now)

    expect((await logic.consume('k', 5, spec)).allowed).toBe(true) // empties
    expect((await logic.consume('k', 1, spec)).allowed).toBe(false)
    now += 2000 // 2s → 2 tokens refilled, still within expiry window
    const d = await logic.consume('k', 1, spec)
    expect(d.allowed).toBe(true)
  })
})

describe('SecurityDurableObjectLogic.alarm — active sweep', () => {
  const spec: TokenBucketSpec = { capacity: 5, refillPerSecond: 1 }

  it('evicts expired rl:/nonce: records and re-arms only while records remain', async () => {
    let now = 3_000_000
    const storage = new InMemoryDurableStorage()
    const logic = new SecurityDurableObjectLogic(storage, () => now)

    // Mint one-shot rate-limit and nonce records (never revisited → lazy expiry
    // alone never reclaims them).
    await logic.consume('one-shot', 1, spec)
    expect(await logic.checkAndStore('nonce-a', 60)).toBe(true)

    // A write arms the sweep alarm.
    expect(await storage.getAlarm()).not.toBeNull()
    expect((await storage.list({ prefix: 'rl:' })).size).toBe(1)
    expect((await storage.list({ prefix: 'nonce:' })).size).toBe(1)

    // Before expiry, the sweep keeps the records and re-arms.
    await logic.alarm()
    expect((await storage.list({ prefix: 'rl:' })).size).toBe(1)
    expect((await storage.list({ prefix: 'nonce:' })).size).toBe(1)
    expect(await storage.getAlarm()).not.toBeNull()

    // Jump past both records' expiry windows; the sweep evicts them and, with
    // nothing left, does NOT re-arm.
    now += 24 * 60 * 60 * 1000 + 1
    await storage.setAlarm(now) // simulate the platform firing (cleared on fire)
    await logic.alarm()
    expect((await storage.list({ prefix: 'rl:' })).size).toBe(0)
    expect((await storage.list({ prefix: 'nonce:' })).size).toBe(0)
    expect(await storage.getAlarm()).toBe(now) // unchanged → not re-armed
  })
})
