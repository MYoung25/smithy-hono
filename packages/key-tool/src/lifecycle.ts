/**
 * Key-lifecycle operations (OPS-03): provision → rotate (overlap) → revoke.
 *
 * These are the reusable, backend-agnostic operations the CLI is a thin wrapper
 * over. They drive a structural {@link WritableKeyBackend} (Redis / Secrets
 * Manager / KV) and emit a `key.rotate` audit event on rotation through the SAME
 * AuditSink path the pipeline uses (`buildAuditEvent` + `emitAudit`), so a
 * deployment's existing audit transport captures rotations with no extra wiring.
 *
 * ## Overlap-window invariant (the load-bearing rule)
 *
 * `verifySignature` looks up a request's key by the keyId in its `Authorization`
 * header (`secrets.getSigningKey(parsed.keyId)`), independent of which key is
 * "current". So these operations maintain the overlap by NEVER deleting the
 * previous key's material at rotation time — they only move the directory's
 * `current` pointer. The old material is deleted later, explicitly, by
 * {@link revokePreviousKey} once the operator is confident no in-flight request
 * is still using it (≥ the signing `acceptanceWindowSeconds`, default 300s).
 */

import { buildAuditEvent, emitAudit } from '@smithy-hono/security-core'
import type { AuditSink, Logger } from '@smithy-hono/security-core'
import type { KeyDirectoryEntry, WritableKeyBackend } from './backend.js'
import { generateHmacSecret, mintKeyId, DEFAULT_SECRET_BYTES } from './keygen.js'

/** Optional audit wiring for lifecycle ops (a deployment passes its real sink). */
export interface LifecycleAudit {
  /** The injected audit destination. Omit to skip emission (still logs locally). */
  sink?: AuditSink
  /** Optional logger for best-effort emission failures. */
  logger?: Logger
  /** A request/correlation id stamped on the event. Default `'key-tool'`. */
  requestId?: string
  /**
   * Pseudonymized principal ref for the OPERATOR running the rotation, if known
   * (LOG-11 — never raw PII). Default `null`.
   */
  principalRef?: string | null
}

/**
 * Determine whether a directory entry represents a live (provisioned) client.
 * `revokeClient` writes a tombstone `{ current: '' }` rather than deleting the
 * entry (the backend interface has no delete-directory primitive), so a truthy
 * entry with an empty `current` is a REVOKED slot, not an active client — it must
 * not block re-provisioning. {@see provisionClient}, {@see rotateClient}.
 */
function isLiveEntry(entry: KeyDirectoryEntry | null): entry is KeyDirectoryEntry {
  return entry !== null && entry.current !== ''
}

/** Result of provisioning a client's first key. */
export interface ProvisionResult {
  clientId: string
  keyId: string
  /** The base64 material that was written — the operator distributes it to the client ONCE. */
  material: string
}

/** Inputs to {@link provisionClient}. */
export interface ProvisionInput {
  clientId: string
  /** Provide a keyId, else one is minted as `<clientId>.<token>`. */
  keyId?: string
  /** Provide base64 material, else a fresh secret of {@link DEFAULT_SECRET_BYTES} is generated. */
  material?: string
  /** Secret length in bytes when generating. Default {@link DEFAULT_SECRET_BYTES}. */
  secretBytes?: number
}

/**
 * Onboard a NEW client: generate (or accept) an HMAC secret, write its material to
 * the backend, and create the directory entry with `current = keyId` (no previous).
 * Fails if the client already has a LIVE directory entry (use {@link rotateClient}).
 * A previously-revoked client (tombstone `{ current: '' }`) is treated as absent so
 * offboard-then-rehire / revoke-then-reissue flows can re-provision a fresh key.
 * Emits a `key.rotate` audit event with `action:'provision'`.
 */
export async function provisionClient(
  backend: WritableKeyBackend,
  input: ProvisionInput,
  audit: LifecycleAudit = {},
): Promise<ProvisionResult> {
  const existing = await backend.getDirectoryEntry(input.clientId)
  if (isLiveEntry(existing)) {
    throw new Error(
      `provisionClient: client '${input.clientId}' already provisioned (current=${existing.current}); use rotateClient`,
    )
  }
  const keyId = input.keyId ?? mintKeyId(input.clientId)
  const material = input.material ?? generateHmacSecret(input.secretBytes ?? DEFAULT_SECRET_BYTES)
  await backend.putKeyMaterial(keyId, material)

  // Atomic compare-and-set closes the provision TOCTOU (KEY-TOOL-05): the
  // existence check above is advisory (it gives a clean error for the common
  // case), but only this NX write makes "create iff absent" a single atomic op,
  // so two concurrent first-provisions can't both win and silently overwrite
  // `current`. A `false` return means an entry already exists between the check
  // and here — re-read to distinguish a concurrent LIVE provision (refuse) from
  // a REVOKED tombstone (`{ current: '' }`), which must be overwritten so the
  // revoke-then-reissue flow still re-provisions.
  const wrote = await backend.putDirectoryEntryIfAbsent(input.clientId, { current: keyId })
  if (!wrote) {
    const present = await backend.getDirectoryEntry(input.clientId)
    if (isLiveEntry(present)) {
      throw new Error(
        `provisionClient: client '${input.clientId}' already provisioned (current=${present.current}); use rotateClient`,
      )
    }
    // A tombstone is present (revoked slot) — NX skipped it; overwrite to reissue.
    await backend.putDirectoryEntry(input.clientId, { current: keyId })
  }

  // Audit the onboarding (key.rotate, action:'provision' — never include material).
  await emitAudit(
    audit.sink,
    buildAuditEvent({
      type: 'key.rotate',
      requestId: audit.requestId ?? 'key-tool',
      principalRef: audit.principalRef ?? null,
      outcome: 'allow',
      detail: { action: 'provision', clientId: input.clientId, keyId },
    }),
    audit.logger,
  )

  return { clientId: input.clientId, keyId, material }
}

/** Result of a rotation. */
export interface RotateResult {
  clientId: string
  /** The new current keyId. */
  newKeyId: string
  /** The keyId now in the overlap window (the prior current); undefined if there was none. */
  previousKeyId?: string
  /** The new base64 material — distribute to the client. */
  material: string
}

/** Inputs to {@link rotateClient}. */
export interface RotateInput {
  clientId: string
  /** Provide the new keyId, else one is minted. MUST differ from the current keyId. */
  newKeyId?: string
  /** Provide base64 material for the new key, else a fresh secret is generated. */
  material?: string
  secretBytes?: number
}

/**
 * Rotate a client to a NEW key while keeping the prior key valid (overlap window).
 *
 * Steps (order matters for safety):
 *  1. Write the NEW key's material (so the new keyId verifies the instant the
 *     pointer moves).
 *  2. Move the directory pointer: `current = newKeyId`, `previous = <old current>`.
 *     The OLD material is deliberately left in place — in-flight requests signed
 *     with it still verify (see the module invariant).
 *  3. Emit a `key.rotate` audit event.
 *
 * Later, once past the acceptance window, the operator calls
 * {@link revokePreviousKey} to delete the old material and close the overlap.
 */
export async function rotateClient(
  backend: WritableKeyBackend,
  input: RotateInput,
  audit: LifecycleAudit = {},
): Promise<RotateResult> {
  const entry = await backend.getDirectoryEntry(input.clientId)
  if (!isLiveEntry(entry)) {
    throw new Error(
      `rotateClient: client '${input.clientId}' is not provisioned; use provisionClient first`,
    )
  }
  const newKeyId = input.newKeyId ?? mintKeyId(input.clientId)
  if (newKeyId === entry.current) {
    throw new Error(`rotateClient: newKeyId '${newKeyId}' equals the current keyId`)
  }
  const material = input.material ?? generateHmacSecret(input.secretBytes ?? DEFAULT_SECRET_BYTES)

  // A second rotation before revoke-previous would overwrite the `previous` pointer
  // and orphan the old previous key's material — unreachable by revoke-previous /
  // revoke yet still verifying forever. Delete it first so "rotate twice" is
  // equivalent to "rotate, revoke-previous, rotate" (KEY-TOOL-01).
  let deletedPreviousKeyId: string | undefined
  if (entry.previous !== undefined && entry.previous !== entry.current) {
    deletedPreviousKeyId = entry.previous
    await backend.deleteKeyMaterial(entry.previous)
  }

  // 1. New material first.
  await backend.putKeyMaterial(newKeyId, material)
  // 2. Move the pointer; keep the prior current as `previous` (overlap).
  const updated: KeyDirectoryEntry = { current: newKeyId, previous: entry.current }
  await backend.putDirectoryEntry(input.clientId, updated)

  // 3. Audit the rotation (key.rotate, the previously-unemitted declared type).
  await emitAudit(
    audit.sink,
    buildAuditEvent({
      type: 'key.rotate',
      requestId: audit.requestId ?? 'key-tool',
      principalRef: audit.principalRef ?? null,
      outcome: 'allow',
      detail: {
        action: 'rotate',
        clientId: input.clientId,
        newKeyId,
        previousKeyId: entry.current,
        // Record the identity of the orphaned previous key this rotation destroyed
        // (KEY-TOOL-01 cleanup), so its deletion leaves a forensic trail.
        ...(deletedPreviousKeyId ? { deletedPreviousKeyId } : {}),
      },
    }),
    audit.logger,
  )

  return {
    clientId: input.clientId,
    newKeyId,
    previousKeyId: entry.current,
    material,
  }
}

/**
 * Close the overlap window: delete the PREVIOUS key's material and clear the
 * `previous` pointer. Run this only after at least the signing acceptance window
 * (default 300s) has elapsed since the rotation, so no in-flight request is still
 * signed with the old key. No-op (returns the cleared keyId as undefined) if there
 * is no previous key. Emits a `key.rotate` event with `action:'revoke-previous'`.
 */
export async function revokePreviousKey(
  backend: WritableKeyBackend,
  clientId: string,
  audit: LifecycleAudit = {},
): Promise<{ clientId: string; revokedKeyId?: string }> {
  const entry = await backend.getDirectoryEntry(clientId)
  if (!entry) {
    throw new Error(`revokePreviousKey: client '${clientId}' is not provisioned`)
  }
  const revokedKeyId = entry.previous
  if (revokedKeyId === undefined) {
    return { clientId, revokedKeyId: undefined }
  }
  await backend.deleteKeyMaterial(revokedKeyId)
  await backend.putDirectoryEntry(clientId, { current: entry.current })

  await emitAudit(
    audit.sink,
    buildAuditEvent({
      type: 'key.rotate',
      requestId: audit.requestId ?? 'key-tool',
      principalRef: audit.principalRef ?? null,
      outcome: 'allow',
      detail: { action: 'revoke-previous', clientId, revokedKeyId },
    }),
    audit.logger,
  )

  return { clientId, revokedKeyId }
}

/**
 * Fully REVOKE a client: delete BOTH its current and previous key material so every
 * signature from it is rejected immediately (verifier 401s an unknown keyId), and
 * clear the directory entry. Use for offboarding or compromise. Emits a
 * `key.rotate` event with `action:'revoke'`. Best-effort on the directory delete:
 * material is the security-relevant part and is removed first.
 */
export async function revokeClient(
  backend: WritableKeyBackend,
  clientId: string,
  audit: LifecycleAudit = {},
): Promise<{ clientId: string; revokedKeyIds: string[] }> {
  const entry = await backend.getDirectoryEntry(clientId)
  if (!entry) {
    throw new Error(`revokeClient: client '${clientId}' is not provisioned`)
  }
  const revokedKeyIds = [entry.current, ...(entry.previous ? [entry.previous] : [])]
  for (const keyId of revokedKeyIds) {
    await backend.deleteKeyMaterial(keyId)
  }
  // Tombstone the directory entry so getCurrentKeyId no longer points at a key.
  await backend.putDirectoryEntry(clientId, { current: '' })

  await emitAudit(
    audit.sink,
    buildAuditEvent({
      type: 'key.rotate',
      requestId: audit.requestId ?? 'key-tool',
      principalRef: audit.principalRef ?? null,
      outcome: 'allow',
      detail: { action: 'revoke', clientId, revokedKeyIds },
    }),
    audit.logger,
  )

  return { clientId, revokedKeyIds }
}
