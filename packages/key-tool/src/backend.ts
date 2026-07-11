/**
 * The backend-agnostic WRITE surface the key-lifecycle library drives (OPS-03).
 *
 * Each runtime adapter ships a concrete implementation:
 *   - `@smithy-hono/adapter-node`  → `RedisKeyBackend`  (material + directory in Redis)
 *   - `@smithy-hono/adapter-aws`   → `AwsKeyBackend`    (Secrets Manager + a directory port)
 *   - `@smithy-hono/adapter-cf`    → `CfKeyBackend`     (KV directory; material out-of-band)
 *
 * The interface is intentionally structural so the library never imports an
 * adapter (no runtime dependency cycle): any object with these methods is a
 * backend. Key MATERIAL is the **base64-encoded** raw HMAC bytes — the SAME
 * encoding the Node/AWS read providers import via `crypto.subtle.importKey`.
 *
 * ## Why current+previous, and how rotation keeps in-flight requests valid
 *
 * `verifySignature` resolves a request's key by the keyId carried in its
 * `Authorization` header via `secrets.getSigningKey(keyId)` — i.e. ANY keyId whose
 * material is still present verifies, regardless of which key is "current". So the
 * overlap window is just: during a rotation the NEW key's material and the OLD
 * key's material are BOTH present; only the directory's `current` pointer moves to
 * the new keyId (so new signatures use it). Requests already in flight, signed
 * with the old keyId, still verify until {@link revokePreviousKey} deletes the old
 * material. This is exactly the model the per-adapter read providers document
 * ("the source still holds the previous keyId, so getSigningKey keeps verifying it
 * within the rotation window, SIGN-05").
 */

/** A client's directory entry: which keyId is current, and the prior one in overlap. */
export interface KeyDirectoryEntry {
  /** The keyId a client should currently sign with (newest). */
  current: string
  /** The prior keyId, kept alive during the rotation overlap window; absent once revoked. */
  previous?: string
}

/**
 * The structural write backend. Material methods persist/read/delete base64 HMAC
 * bytes by keyId; directory methods persist/read the client→keyId mapping. A
 * backend whose material plane is out-of-band (Cloudflare) MAY throw from
 * `putKeyMaterial`/`deleteKeyMaterial` — the library surfaces that to the operator.
 */
export interface WritableKeyBackend {
  putKeyMaterial(keyId: string, material: string): Promise<void>
  getKeyMaterial(keyId: string): Promise<string | null>
  deleteKeyMaterial(keyId: string): Promise<void>
  getDirectoryEntry(clientId: string): Promise<KeyDirectoryEntry | null>
  putDirectoryEntry(clientId: string, entry: KeyDirectoryEntry): Promise<void>
  /**
   * Atomically create a directory entry only if no entry currently exists
   * (compare-and-set, NX). Returns `true` if this call wrote the entry, `false`
   * if one was already present (the entry is NOT overwritten). Closes the
   * provision TOCTOU (KEY-TOOL-05): the existence check and the create become a
   * single atomic operation, so two concurrent provisions can't both win.
   */
  putDirectoryEntryIfAbsent(clientId: string, entry: KeyDirectoryEntry): Promise<boolean>
}
