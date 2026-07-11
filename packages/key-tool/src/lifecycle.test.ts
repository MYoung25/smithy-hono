/**
 * Lifecycle library tests (OPS-03): provision → rotate (overlap) → revoke, the
 * `key.rotate` audit emission, and the load-bearing overlap-window invariant — a
 * request signed with the PREVIOUS key still verifies after rotation, and stops
 * verifying only once the previous key is revoked.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { AuditEvent, AuditSink } from '@smithy-hono/security-core'
import { importHmacKey, signRequest } from '@smithy-hono/security-core'
import type { KeyDirectoryEntry, WritableKeyBackend } from './backend.js'
import {
  provisionClient,
  rotateClient,
  revokePreviousKey,
  revokeClient,
} from './lifecycle.js'

/** A trivial in-memory {@link WritableKeyBackend} for unit tests. */
function memoryBackend(): WritableKeyBackend & { material: Map<string, string> } {
  const material = new Map<string, string>()
  const directory = new Map<string, KeyDirectoryEntry>()
  return {
    material,
    async putKeyMaterial(keyId, m) {
      material.set(keyId, m)
    },
    async getKeyMaterial(keyId) {
      return material.get(keyId) ?? null
    },
    async deleteKeyMaterial(keyId) {
      material.delete(keyId)
    },
    async getDirectoryEntry(clientId) {
      return directory.get(clientId) ?? null
    },
    async putDirectoryEntry(clientId, entry) {
      directory.set(clientId, entry)
    },
    async putDirectoryEntryIfAbsent(clientId, entry) {
      if (directory.has(clientId)) return false
      directory.set(clientId, entry)
      return true
    },
  }
}

/** Capture emitted audit events. */
function captureSink(): AuditSink & { events: AuditEvent[] } {
  const events: AuditEvent[] = []
  return {
    events,
    async emit(e) {
      events.push(e)
    },
  }
}

/**
 * Build a verify-only CryptoKey from the base64 material the backend stored — this
 * mimics what the Node read provider does, so verifying with it proves a live
 * verifier would accept the signature for that keyId.
 */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

async function verifyKeyFromMaterial(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', base64ToBytes(b64), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'verify',
  ])
}

describe('provisionClient', () => {
  let backend: ReturnType<typeof memoryBackend>
  beforeEach(() => {
    backend = memoryBackend()
  })

  it('generates a key, writes material, and sets current (no previous)', async () => {
    const res = await provisionClient(backend, { clientId: 'client-a' })
    expect(res.keyId).toMatch(/^client-a\./)
    expect(res.material.length).toBeGreaterThan(0)
    expect(await backend.getKeyMaterial(res.keyId)).toBe(res.material)
    expect(await backend.getDirectoryEntry('client-a')).toEqual({ current: res.keyId })
  })

  it('refuses to re-provision an existing client', async () => {
    await provisionClient(backend, { clientId: 'client-a' })
    await expect(provisionClient(backend, { clientId: 'client-a' })).rejects.toThrow(/already/)
  })

  it('emits a key.rotate audit event with action:provision (no material) (KEY-TOOL-06)', async () => {
    const sink = captureSink()
    const res = await provisionClient(backend, { clientId: 'client-a' }, { sink })
    expect(sink.events).toHaveLength(1)
    expect(sink.events[0].type).toBe('key.rotate')
    expect(sink.events[0].detail).toMatchObject({
      action: 'provision',
      clientId: 'client-a',
      keyId: res.keyId,
    })
    // The secret material must never land in the audit detail.
    expect(JSON.stringify(sink.events[0].detail)).not.toContain(res.material)
  })

  it('allows re-provisioning a previously-revoked (tombstoned) client (KEY-TOOL-02)', async () => {
    const first = await provisionClient(backend, { clientId: 'client-a' })
    await revokeClient(backend, 'client-a')
    // Tombstone present ({ current: '' }) — provision must NOT treat it as live.
    const second = await provisionClient(backend, { clientId: 'client-a' })
    expect(second.keyId).not.toBe(first.keyId)
    expect(await backend.getDirectoryEntry('client-a')).toEqual({ current: second.keyId })
    expect(await backend.getKeyMaterial(second.keyId)).toBe(second.material)
  })

  it('is atomic: a concurrent provision after an entry exists does not overwrite current (KEY-TOOL-05)', async () => {
    // Simulate the TOCTOU loser: an entry already exists when the NX write runs.
    const first = await provisionClient(backend, { clientId: 'client-a' })
    // A racing provision must observe the live entry via the atomic CAS and refuse,
    // leaving the original `current` pointer intact (no silent overwrite).
    await expect(provisionClient(backend, { clientId: 'client-a' })).rejects.toThrow(/already/)
    expect(await backend.getDirectoryEntry('client-a')).toEqual({ current: first.keyId })
  })

  it('accepts an explicit keyId and material', async () => {
    const res = await provisionClient(backend, {
      clientId: 'c',
      keyId: 'c.fixed',
      material: 'AAAA',
    })
    expect(res.keyId).toBe('c.fixed')
    expect(await backend.getKeyMaterial('c.fixed')).toBe('AAAA')
  })
})

describe('rotateClient — overlap window', () => {
  let backend: ReturnType<typeof memoryBackend>
  beforeEach(() => {
    backend = memoryBackend()
  })

  it('moves current, keeps previous, and emits key.rotate', async () => {
    const sink = captureSink()
    const first = await provisionClient(backend, { clientId: 'client-a' })
    const rot = await rotateClient(backend, { clientId: 'client-a' }, { sink })

    expect(rot.previousKeyId).toBe(first.keyId)
    expect(rot.newKeyId).not.toBe(first.keyId)
    // Directory points at the new key; old key kept as previous.
    expect(await backend.getDirectoryEntry('client-a')).toEqual({
      current: rot.newKeyId,
      previous: first.keyId,
    })
    // BOTH materials still present → overlap window.
    expect(await backend.getKeyMaterial(first.keyId)).not.toBeNull()
    expect(await backend.getKeyMaterial(rot.newKeyId)).not.toBeNull()
    // key.rotate emitted with rotation detail.
    expect(sink.events).toHaveLength(1)
    expect(sink.events[0].type).toBe('key.rotate')
    expect(sink.events[0].detail).toMatchObject({
      action: 'rotate',
      clientId: 'client-a',
      newKeyId: rot.newKeyId,
      previousKeyId: first.keyId,
    })
  })

  it('a request signed with the PREVIOUS key still verifies after rotation, then fails after revoke-previous', async () => {
    const first = await provisionClient(backend, { clientId: 'client-a' })

    // Sign a request with the ORIGINAL key (as an in-flight client would).
    const signKey = await importHmacKey(base64ToBytes(first.material), ['sign'])
    const ts = Math.floor(Date.now() / 1000)
    const signed = await signRequest({
      method: 'POST',
      url: 'https://api.example.com/todos',
      headers: { host: 'api.example.com', 'x-sh-timestamp': String(ts) },
      body: '{"title":"x"}',
      keyId: first.keyId,
      key: signKey,
      signedHeaders: ['host', 'x-sh-timestamp'],
      timestamp: ts,
    })
    const sigHex = signed.authorization.match(/signature=([0-9a-f]+)/)![1]
    const sigBytes = Uint8Array.from(sigHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)))
    const canonicalBytes = new TextEncoder().encode(signed.canonicalString)

    // Rotate. The previous key's material is still present → it must still verify.
    await rotateClient(backend, { clientId: 'client-a' })
    const prevMaterial = await backend.getKeyMaterial(first.keyId)
    expect(prevMaterial).not.toBeNull()
    const verifyKeyDuringOverlap = await verifyKeyFromMaterial(prevMaterial!)
    expect(
      await crypto.subtle.verify('HMAC', verifyKeyDuringOverlap, sigBytes, canonicalBytes),
    ).toBe(true)

    // Close the overlap: revoke previous → material gone → verifier 401s (unknown key).
    await revokePreviousKey(backend, 'client-a')
    expect(await backend.getKeyMaterial(first.keyId)).toBeNull()
    expect((await backend.getDirectoryEntry('client-a'))!.previous).toBeUndefined()
  })

  it('rejects rotating an unprovisioned client', async () => {
    await expect(rotateClient(backend, { clientId: 'ghost' })).rejects.toThrow(/not provisioned/)
  })

  it('double rotation deletes the orphaned previous material so it stays revocable (KEY-TOOL-01)', async () => {
    const first = await provisionClient(backend, { clientId: 'client-a' })
    const rot1 = await rotateClient(backend, { clientId: 'client-a' })
    // Second rotation BEFORE revoke-previous: the prior previous (first.keyId) must
    // not be orphaned — its material is deleted, and `previous` now points at rot1.
    const rot2 = await rotateClient(backend, { clientId: 'client-a' })

    expect(await backend.getKeyMaterial(first.keyId)).toBeNull()
    expect(await backend.getDirectoryEntry('client-a')).toEqual({
      current: rot2.newKeyId,
      previous: rot1.newKeyId,
    })
    // The still-valid overlap key (rot1) and the new current both remain present.
    expect(await backend.getKeyMaterial(rot1.newKeyId)).not.toBeNull()
    expect(await backend.getKeyMaterial(rot2.newKeyId)).not.toBeNull()

    // revoke-previous now closes the remaining overlap fully — no orphan left behind.
    await revokePreviousKey(backend, 'client-a')
    expect(await backend.getKeyMaterial(rot1.newKeyId)).toBeNull()
    // Only the current key's material survives in the whole material plane.
    expect([...backend.material.keys()]).toEqual([rot2.newKeyId])
  })

  it('refuses to rotate a revoked (tombstoned) client — re-provision instead (KEY-TOOL-02)', async () => {
    await provisionClient(backend, { clientId: 'client-a' })
    await revokeClient(backend, 'client-a')
    await expect(rotateClient(backend, { clientId: 'client-a' })).rejects.toThrow(/not provisioned/)
  })

  it('records the destroyed orphan keyId in the rotate audit detail (KEY-TOOL-01 forensics)', async () => {
    const sink = captureSink()
    const first = await provisionClient(backend, { clientId: 'client-a' })
    await rotateClient(backend, { clientId: 'client-a' }) // rot1 (no orphan destroyed yet)
    sink.events.length = 0
    // Second rotation destroys `first.keyId` — its identity must now appear in the audit.
    await rotateClient(backend, { clientId: 'client-a' }, { sink })
    expect(sink.events).toHaveLength(1)
    expect(sink.events[0].detail).toMatchObject({
      action: 'rotate',
      deletedPreviousKeyId: first.keyId,
    })
  })

  it('omits deletedPreviousKeyId when no orphan material was destroyed', async () => {
    const sink = captureSink()
    await provisionClient(backend, { clientId: 'client-a' })
    // First rotation has no pre-empted previous key to delete.
    await rotateClient(backend, { clientId: 'client-a' }, { sink })
    expect(sink.events.at(-1)?.detail).not.toHaveProperty('deletedPreviousKeyId')
  })
})

describe('revokePreviousKey / revokeClient', () => {
  let backend: ReturnType<typeof memoryBackend>
  beforeEach(() => {
    backend = memoryBackend()
  })

  it('revoke-previous is a no-op when there is no previous key', async () => {
    await provisionClient(backend, { clientId: 'c' })
    const res = await revokePreviousKey(backend, 'c')
    expect(res.revokedKeyId).toBeUndefined()
  })

  it('revoke deletes all material and emits key.rotate', async () => {
    const sink = captureSink()
    const first = await provisionClient(backend, { clientId: 'c' })
    const rot = await rotateClient(backend, { clientId: 'c' }, { sink })
    const res = await revokeClient(backend, 'c', { sink })
    expect(res.revokedKeyIds).toEqual(expect.arrayContaining([first.keyId, rot.newKeyId]))
    expect(await backend.getKeyMaterial(first.keyId)).toBeNull()
    expect(await backend.getKeyMaterial(rot.newKeyId)).toBeNull()
    // last event is the revoke
    expect(sink.events.at(-1)).toMatchObject({ type: 'key.rotate', detail: { action: 'revoke' } })
  })
})
