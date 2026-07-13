/**
 * DynamoDB-backed {@link NonceStore} (SIGN-03/10) — STRONGLY CONSISTENT.
 *
 * Replay defense: `checkAndStore` returns `true` exactly once for a given nonce
 * within its TTL window, `false` on any replay. The mandate (plan 11, docs 00 &
 * 07) is exactly-once acceptance under concurrency.
 *
 * Mechanism: a conditional `putItem(item, { ifNotExists: true })` — DynamoDB's
 * `attribute_not_exists(pk)` — is first-write-wins and strongly consistent, so
 * exactly one of N concurrent inserts of the same fresh nonce succeeds. This is
 * the hot path the conformance "exactly-once under concurrency" check exercises.
 *
 * Re-acceptance after expiry: DynamoDB TTL deletion is EVENTUAL, so an expired
 * nonce's row may still be present when the window lapses. We track the precise
 * deadline in `expiresAtMs` (millis; the `ttl` attr is only second-granular for
 * the backend sweep). On a conditional-put miss we reclaim an EXPIRED row via a
 * single CAS overwrite that stamps a per-call unique `owner` token; we then
 * confirm WE are the row now present. The CAS version-guard makes the overwrite
 * first-write-wins, and the unique-owner read-back disambiguates concurrent
 * reclaimers — so re-acceptance stays exactly-once.
 *
 * Keyed `nonce:<nonce>`.
 */

import type { NonceStore } from '@smithy-hono/security-core/storage'
import type { DynamoTablePort } from '../port.js'
import { TTL_ATTR } from '../port.js'

const nowMs = (): number => Date.now()

const keyFor = (nonce: string): { pk: string } => ({ pk: `nonce:${nonce}` })

let ownerCounter = 0
/** Process-unique token so concurrent reclaimers of the same expired nonce can be told apart. */
function newOwner(): string {
  ownerCounter += 1
  return `${Date.now().toString(36)}-${ownerCounter.toString(36)}-${Math.random().toString(36).slice(2)}`
}

export class DynamoNonceStore implements NonceStore {
  constructor(private readonly port: DynamoTablePort) {}

  async checkAndStore(nonce: string, ttlSeconds: number): Promise<boolean> {
    const k = keyFor(nonce)
    const expiresAtMs = nowMs() + ttlSeconds * 1000
    const owner = newOwner()
    const item = {
      ...k,
      owner,
      expiresAtMs,
      [TTL_ATTR]: Math.ceil(expiresAtMs / 1000),
    }

    // Fast path: first-write-wins conditional insert (the live, hot case).
    if (await this.port.putItem(item, { ifNotExists: true })) {
      return true
    }

    // The row exists. Reclaim it via CAS ONLY if it is past its precise deadline
    // (eventual-TTL lag). The version-guard makes the overwrite first-write-wins.
    const committed = await this.port.updateConditional(k, (current) => {
      if (current) {
        // An UNREADABLE deadline (missing / non-numeric `expiresAtMs`) must be
        // treated as already-expired (reclaimable), NOT as `Infinity`-live: a
        // poisoned/legacy row defaulting to `Infinity` would permanently and
        // silently deny the legitimate first use of this nonce. Default to
        // `-Infinity` so `prevExpiry > nowMs()` is false and the malformed row is
        // reclaimed, while genuine replays (a real future numeric `expiresAtMs`)
        // stay rejected.
        const prevExpiry = typeof current.expiresAtMs === 'number' ? current.expiresAtMs : -Infinity
        if (prevExpiry > nowMs()) return null // still live → replay, do not store
      }
      return item // absent or expired → reclaim with our owner token
    })
    if (!committed) return false // lost the CAS race → treat as replay

    // Read-after-write: accept only if OUR owner token is the one now present.
    const current = await this.port.getItem(k)
    return !!current && current.owner === owner
  }
}
