/**
 * DynamoDB-backed {@link SessionStore} (AUTH-04/05, CSRF-03).
 *
 * One item per session, keyed `sess:<sessionId>`. The session payload is stored
 * under `rec`. Idle expiry is tracked TWO ways:
 *   - `ttl` (epoch SECONDS, the table's TTL attribute) — drives DynamoDB's own
 *     eventual sweep of dead rows (a storage-cost optimization only).
 *   - `expiresAtMs` (epoch MILLIS) — the AUTHORITATIVE idle deadline used by the
 *     in-code expiry guard. DynamoDB TTL only has second granularity and its
 *     deletion is EVENTUAL (can lag ~48h), so `get` NEVER trusts the backend to
 *     have swept the row: it lazily treats any item past `expiresAtMs` OR past
 *     the record's `absoluteExpiry` as absent (matches the memory store).
 */

import type {
  SessionRecord,
  SessionStore,
} from '@smithy-hono/security-core/storage'
import type { DynamoTablePort } from '../port.js'
import { TTL_ATTR } from '../port.js'

const nowMs = (): number => Date.now()

const keyFor = (sessionId: string): { pk: string } => ({ pk: `sess:${sessionId}` })

/** Build the persisted ttl pair from an idle TTL (seconds, may be fractional). */
function ttlFields(idleTtlSeconds: number): { expiresAtMs: number; [TTL_ATTR]: number } {
  const expiresAtMs = nowMs() + idleTtlSeconds * 1000
  return {
    expiresAtMs,
    // DynamoDB TTL is epoch SECONDS; ceil so the backend never sweeps early.
    [TTL_ATTR]: Math.ceil(expiresAtMs / 1000),
  }
}

export class DynamoSessionStore implements SessionStore {
  constructor(private readonly port: DynamoTablePort) {}

  async get(sessionId: string): Promise<SessionRecord | null> {
    const item = await this.port.getItem(keyFor(sessionId))
    if (!item) return null
    const rec = item.rec as SessionRecord | undefined
    if (!rec) return null
    const expiresAtMs = typeof item.expiresAtMs === 'number' ? item.expiresAtMs : 0
    // Lazy eviction: lapsed idle deadline or passed absolute cap → treat as gone.
    if (expiresAtMs <= nowMs() || rec.absoluteExpiry <= nowMs()) {
      return null
    }
    return rec
  }

  async set(sessionId: string, rec: SessionRecord, ttlSeconds: number): Promise<void> {
    await this.port.putItem({
      ...keyFor(sessionId),
      rec,
      ...ttlFields(ttlSeconds),
    })
  }

  async delete(sessionId: string): Promise<void> {
    await this.port.deleteItem(keyFor(sessionId))
  }

  async touch(sessionId: string, idleTtlSeconds: number): Promise<void> {
    // Slide the idle TTL via CAS so we never resurrect a row that was deleted or
    // whose absolute cap has passed between the read and the write.
    await this.port.updateConditional(keyFor(sessionId), (current) => {
      if (!current) return null // gone → no-op (touch on missing is a no-op)
      const rec = current.rec as SessionRecord | undefined
      if (!rec || rec.absoluteExpiry <= nowMs()) return null // never revive past absolute cap
      return { ...current, ...ttlFields(idleTtlSeconds) }
    })
  }
}
