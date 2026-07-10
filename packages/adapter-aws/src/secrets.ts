/**
 * Secrets Manager-backed {@link SecretProvider} (SIGN-05/06).
 *
 * HMAC signing keys live ONLY in Secrets Manager — never in code or config
 * (SIGN-06). This provider resolves them through a structural
 * {@link SecretsSourceLike} port, so the package typechecks/tests WITHOUT the
 * AWS SDK (ARCH-01). The consumer wires
 * `SecretsManagerClient.send(new GetSecretValueCommand(...))` behind the port.
 *
 * Mappings (provided at construction, from config — not hardcoded):
 *   - `keyIdToSecretId`:  keyId → Secrets Manager secret ID/ARN.
 *   - `clientToCurrentKeyId`: clientId → the keyId it should currently sign with
 *     (newest in the rotation window, SIGN-05).
 *
 * Key material encoding: the secret STRING is the raw HMAC key encoded as
 * **base64** (chosen; documented in the README). It is imported via
 * `crypto.subtle.importKey('raw', bytes, { name:'HMAC', hash:'SHA-256' }, false,
 * ['verify'])` — verify-only, non-extractable. Imported keys are cached by keyId
 * so we don't re-fetch/re-import on every request; `null` is returned for an
 * unknown/retired keyId (the verifier then fails closed).
 */

import type { SecretProvider } from '@smithy-hono/security-core/storage'

/** The minimal structural Secrets Manager surface this provider needs. */
export interface SecretsSourceLike {
  /** Resolve the secret string for `secretId`, or `null` if not found. */
  getSecretString(secretId: string): Promise<string | null>
}

export interface DynamoSecretProviderOptions {
  /** keyId → Secrets Manager secret ID/ARN. */
  keyIdToSecretId: Record<string, string>
  /** clientId → current keyId (SIGN-05 rotation window). */
  clientToCurrentKeyId: Record<string, string>
  /** HMAC hash algorithm. Default `'SHA-256'`. */
  hash?: 'SHA-256' | 'SHA-384' | 'SHA-512'
  /**
   * How long (ms) an imported key stays cached before Secrets Manager is
   * re-consulted (SIGN-05 revocation safety). A revoked/rotated-out key keeps
   * verifying on a warmed long-lived provider for AT MOST this window: once stale,
   * the next `getSigningKey` re-fetches and, if the secret is now gone, evicts and
   * fails closed. Default 300_000 (5 min — the signing acceptance window). Set `0`
   * to re-fetch on every call (strictest, one Secrets Manager read per request).
   */
  cacheTtlMs?: number
}

/** Decode a base64 string to an ArrayBuffer using Web-standard `atob` (no `Buffer`, ARCH-01). */
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64.trim())
  const buf = new ArrayBuffer(bin.length)
  const out = new Uint8Array(buf)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return buf
}

/** Default cache TTL (ms): the SIGN-05 signing-acceptance / rotation window. */
const DEFAULT_CACHE_TTL_MS = 300_000

export class SecretsManagerSecretProvider implements SecretProvider {
  private readonly keyIdToSecretId: Record<string, string>
  private readonly clientToCurrentKeyId: Record<string, string>
  private readonly hash: string
  private readonly cacheTtlMs: number
  /** keyId → imported CryptoKey (or in-flight promise) plus its cache timestamp. */
  private readonly cache = new Map<
    string,
    { promise: Promise<CryptoKey | null>; importedAtMs: number }
  >()

  constructor(
    private readonly source: SecretsSourceLike,
    opts: DynamoSecretProviderOptions,
  ) {
    this.keyIdToSecretId = opts.keyIdToSecretId
    this.clientToCurrentKeyId = opts.clientToCurrentKeyId
    this.hash = opts.hash ?? 'SHA-256'
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  }

  async getSigningKey(keyId: string): Promise<CryptoKey | null> {
    // Revocation-aware cache (SIGN-05): a cached import is only trusted within the
    // TTL. Once stale we re-fetch from Secrets Manager so a rotated-out/revoked key
    // (whose secret the lifecycle tool deleted) stops verifying — evict and fail
    // closed when the re-fetch returns null.
    const cached = this.cache.get(keyId)
    if (cached && Date.now() - cached.importedAtMs < this.cacheTtlMs) return cached.promise
    // Evict on REJECTION (throttle/network/malformed material) so a single
    // transient error doesn't pin a rejected promise in the cache and re-throw it
    // for the whole TTL (a self-inflicted verification outage for this key). Only
    // `null` (unknown key) is a cacheable-then-evicted miss; true failures retry.
    const p = this.importKey(keyId).catch((e) => {
      this.cache.delete(keyId)
      throw e
    })
    this.cache.set(keyId, { promise: p, importedAtMs: Date.now() })
    const key = await p
    if (key === null) this.cache.delete(keyId) // don't cache misses permanently.
    return key
  }

  async getCurrentKeyId(clientId: string): Promise<string> {
    const id = this.clientToCurrentKeyId[clientId]
    if (id === undefined) {
      throw new Error(`No current signing key configured for client '${clientId}' (SIGN-05)`)
    }
    return id
  }

  private async importKey(keyId: string): Promise<CryptoKey | null> {
    const secretId = this.keyIdToSecretId[keyId]
    if (secretId === undefined) return null // unknown/retired keyId.
    const material = await this.source.getSecretString(secretId)
    if (material === null) return null
    const keyData = base64ToArrayBuffer(material)
    return crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: this.hash },
      false, // non-extractable
      ['verify'],
    )
  }
}

// ===========================================================================
// OPS-03 — key LIFECYCLE write backend (AWS, end-to-end behind structural ports).
//
// Unlike Workers secrets, AWS Secrets Manager IS writable at runtime through the
// SDK (`PutSecretValue` / `CreateSecret` / `DeleteSecret`), so the AWS backend can
// implement the full lifecycle. Per ARCH-01 it does so through a STRUCTURAL port
// ({@link WritableSecretsSourceLike}) — the consumer wires the real
// `SecretsManagerClient` behind it, exactly like the read path's
// {@link SecretsSourceLike}. The client→keyId directory plane is a second
// structural port ({@link KeyDirectoryPortLike}); a DynamoDB-backed implementation
// (one item per client) satisfies it. Both are injectable so the backend
// typechecks/tests without `@aws-sdk/*`.
// ===========================================================================

/** Write surface over Secrets Manager (the consumer wires the SDK behind it). */
export interface WritableSecretsSourceLike extends SecretsSourceLike {
  /** Create-or-update the secret STRING for `secretId` (base64 HMAC material). */
  putSecretString(secretId: string, material: string): Promise<void>
  /** Delete the secret for `secretId` (revocation). */
  deleteSecret(secretId: string): Promise<void>
}

/** A client's current/previous keyId mapping (the directory plane). */
export interface AwsKeyDirectoryEntry {
  current: string
  previous?: string
}

/** Structural port for the client→keyId directory (e.g. one DynamoDB item per client). */
export interface KeyDirectoryPortLike {
  getEntry(clientId: string): Promise<AwsKeyDirectoryEntry | null>
  putEntry(clientId: string, entry: AwsKeyDirectoryEntry): Promise<void>
}

/** Options for {@link AwsKeyBackend}. */
export interface AwsKeyBackendOptions {
  /**
   * Map a keyId → Secrets Manager secret ID/ARN for WRITE ops. If a keyId is not
   * present, `${secretIdPrefix}${keyId}` is used (so newly provisioned keys get a
   * deterministic secret id without pre-registration).
   */
  keyIdToSecretId?: Record<string, string>
  /** Prefix for the derived secret id of an unmapped keyId. Default `sh/signing-key/`. */
  secretIdPrefix?: string
}

/**
 * AWS key-lifecycle backend: material in Secrets Manager (writable via
 * {@link WritableSecretsSourceLike}), directory in {@link KeyDirectoryPortLike}.
 * Implements the same lifecycle surface the node backend does, end-to-end.
 */
export class AwsKeyBackend {
  readonly #source: WritableSecretsSourceLike
  readonly #directory: KeyDirectoryPortLike
  readonly #keyIdToSecretId: Record<string, string>
  readonly #secretIdPrefix: string

  constructor(
    source: WritableSecretsSourceLike,
    directory: KeyDirectoryPortLike,
    opts: AwsKeyBackendOptions = {},
  ) {
    this.#source = source
    this.#directory = directory
    this.#keyIdToSecretId = opts.keyIdToSecretId ?? {}
    this.#secretIdPrefix = opts.secretIdPrefix ?? 'sh/signing-key/'
  }

  #secretId(keyId: string): string {
    return this.#keyIdToSecretId[keyId] ?? this.#secretIdPrefix + keyId
  }

  async putKeyMaterial(keyId: string, material: string): Promise<void> {
    await this.#source.putSecretString(this.#secretId(keyId), material)
  }

  async getKeyMaterial(keyId: string): Promise<string | null> {
    return this.#source.getSecretString(this.#secretId(keyId))
  }

  async deleteKeyMaterial(keyId: string): Promise<void> {
    await this.#source.deleteSecret(this.#secretId(keyId))
  }

  async getDirectoryEntry(clientId: string): Promise<AwsKeyDirectoryEntry | null> {
    return this.#directory.getEntry(clientId)
  }

  async putDirectoryEntry(clientId: string, entry: AwsKeyDirectoryEntry): Promise<void> {
    await this.#directory.putEntry(clientId, entry)
  }
}
