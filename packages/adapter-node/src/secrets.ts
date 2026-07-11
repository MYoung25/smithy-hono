/**
 * {@link SecretProvider} (SIGN-05/06) for Node — resolves HMAC signing keys from
 * an INJECTED structural secret source, never from `process.env` inside core
 * logic and never from code/config. Keys are imported as Web-standard
 * {@link CryptoKey}s via `crypto.subtle.importKey` with usage `['verify']`
 * (ARCH-01).
 *
 * Raw HMAC material encoding: **base64** (standard, with padding). Pick one and
 * document it — a mounted k8s secret / env var holds the base64-encoded raw key
 * bytes; `getCurrentKeyId` resolves a client's current key via an injected
 * clientId→keyId map (rotation: the source still holds the previous keyId, so
 * `getSigningKey` keeps verifying it within the rotation window, SIGN-05).
 */

import type { SecretProvider } from '@smithy-hono/security-core/storage'
import type { RedisPort } from './ports.js'

/**
 * The structural secret source the provider reads raw key material from. A
 * mounted-secret loader, a Vault client, or a plain record all satisfy this.
 * Returns the **base64-encoded** raw HMAC bytes for `keyId`, or `null` if
 * unknown/retired.
 */
export interface SecretSourceLike {
  get(keyId: string): Promise<string | null>
}

/** HMAC import hash (matches the signing scheme; SHA-256 default). */
export type HmacHash = 'SHA-256' | 'SHA-384' | 'SHA-512'

export interface NodeSecretProviderOptions {
  /** clientId → the key ID it should currently sign with (newest in rotation). */
  currentKeyByClient: Readonly<Record<string, string>>
  /** HMAC hash to import keys under. Default `SHA-256`. */
  hash?: HmacHash
  /**
   * How long (ms) an imported key stays cached before the source is re-consulted
   * (SIGN-05 revocation safety). A revoked/rotated-out key keeps verifying on a
   * warmed long-lived provider for AT MOST this window: once stale, the next
   * `getSigningKey` re-reads the source and, if the material is now gone, evicts
   * and fails closed. Default 300_000 (5 min — the signing acceptance window).
   * Set `0` to re-consult the source on every call (strictest, one source read
   * per request).
   */
  cacheTtlMs?: number
}

/** Decode standard base64 (with padding) to bytes, without relying on node Buffer. */
function base64ToBytes(b64: string): ArrayBuffer {
  // `atob` is available on Web-standard runtimes and modern Node (lib: DOM).
  const bin = atob(b64)
  const buf = new ArrayBuffer(bin.length)
  const out = new Uint8Array(buf)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return buf
}

/** Default cache TTL (ms): the SIGN-05 signing-acceptance / rotation window. */
const DEFAULT_CACHE_TTL_MS = 300_000

/**
 * Node {@link SecretProvider} over a structural {@link SecretSourceLike}.
 *
 * `getSigningKey` fetches the base64 material for `keyId`, imports it as a
 * non-extractable HMAC `CryptoKey` with `['verify']` usage, and returns it (or
 * `null` if the source has no such key — unknown/retired). Imported keys are
 * memoized (within {@link NodeSecretProviderOptions.cacheTtlMs}) so repeated
 * verifications don't re-import, while a revoked/rotated-out key stops verifying
 * once the TTL lapses (SIGN-05).
 */
export class NodeSecretProvider implements SecretProvider {
  readonly #source: SecretSourceLike
  readonly #currentKeyByClient: Readonly<Record<string, string>>
  readonly #hash: HmacHash
  readonly #cacheTtlMs: number
  /** keyId → imported key plus the ms timestamp it was cached at (for TTL eviction). */
  readonly #cache = new Map<string, { key: CryptoKey; importedAtMs: number }>()

  constructor(source: SecretSourceLike, opts: NodeSecretProviderOptions) {
    this.#source = source
    this.#currentKeyByClient = opts.currentKeyByClient
    this.#hash = opts.hash ?? 'SHA-256'
    this.#cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  }

  async getSigningKey(keyId: string): Promise<CryptoKey | null> {
    // Revocation-aware cache (SIGN-05): a cached key is only trusted within the
    // TTL. Once stale we re-consult the source so a rotated-out/revoked key (whose
    // material the lifecycle tool deleted) stops verifying — evict and fail closed
    // when the re-read returns null.
    const cached = this.#cache.get(keyId)
    if (cached && Date.now() - cached.importedAtMs < this.#cacheTtlMs) return cached.key
    const material = await this.#source.get(keyId)
    if (material === null) {
      this.#cache.delete(keyId) // evicted/revoked at the source — fail closed.
      return null
    }
    const key = await crypto.subtle.importKey(
      'raw',
      base64ToBytes(material),
      { name: 'HMAC', hash: this.#hash },
      false, // non-extractable
      ['verify'],
    )
    this.#cache.set(keyId, { key, importedAtMs: Date.now() })
    return key
  }

  async getCurrentKeyId(clientId: string): Promise<string> {
    const id = this.#currentKeyByClient[clientId]
    if (id === undefined) {
      throw new Error(`No current signing key registered for client '${clientId}'`)
    }
    return id
  }
}

/**
 * Convenience wrapper turning a plain readonly record of base64 key material into
 * a {@link SecretSourceLike}. Keys never live in code (SIGN-06) — this is for
 * tests / a deployment that has already loaded the record from a secret manager.
 */
export function recordSecretSource(
  keys: Readonly<Record<string, string>>,
): SecretSourceLike {
  return {
    async get(keyId) {
      return keys[keyId] ?? null
    },
  }
}

// ===========================================================================
// OPS-03 — key LIFECYCLE backend (provision / rotate / revoke).
//
// The read path above is intentionally read-only (verification never mutates
// keys). The lifecycle tool (`@smithy-hono/key-tool`) drives a separate WRITE
// surface defined in security-core-agnostic terms here: a `WritableKeyBackend`
// that stores key material AND a client→keyId directory durably in Redis, using
// the SAME structural {@link RedisPort} the stores already use (no SDK; ARCH-01).
//
// Rotation preserves the overlap window that {@link verifySignature} relies on:
// it resolves a request's key by the keyId carried in the Authorization header via
// `getSigningKey(keyId)` — i.e. ANY keyId whose material is still present verifies,
// independently of which key is "current". So rotate = write the new key material +
// repoint the client's CURRENT keyId, while LEAVING the previous keyId's material in
// place (and remembered as PREVIOUS). In-flight requests still signed with the old
// keyId keep verifying until `revokePreviousKey` deletes that material.
// ===========================================================================

/**
 * The persistent client→keyId directory entry. Mirrors the rotation model the
 * read provider expects: a `current` keyId every new request signs with, plus an
 * optional `previous` keyId kept alive for the overlap window so in-flight
 * requests signed with the old key still verify (SIGN-05).
 */
export interface KeyDirectoryEntry {
  /** The keyId a client should currently sign with (newest). */
  current: string
  /** The prior keyId, retained during the rotation overlap window; absent once revoked. */
  previous?: string
}

/**
 * Parse a stored directory entry, failing CLOSED on a corrupt or wrong-shaped
 * value. The directory store is writable out-of-band, so a malformed JSON value
 * (raw `SyntaxError`) or a valid-but-shapeless one (`current` missing/non-string)
 * must surface as a descriptive, namespaced error rather than letting `undefined`
 * flow downstream into `deleteKeyMaterial`/pointer writes.
 */
function parseDirectoryEntry(raw: string, clientId: string): KeyDirectoryEntry {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Corrupt directory entry for client '${clientId}': not valid JSON`)
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { current?: unknown }).current !== 'string'
  ) {
    throw new Error(
      `Corrupt directory entry for client '${clientId}': missing string 'current'`,
    )
  }
  return parsed as KeyDirectoryEntry
}

/**
 * The write surface the key-lifecycle tool drives. Backend-agnostic: a Redis,
 * Secrets-Manager, or Workers-secret implementation all satisfy it. Material is
 * the **base64-encoded** raw HMAC bytes (same encoding the Node read provider
 * imports). Implementations MUST be durable so a rotated/revoked state survives
 * process restarts.
 */
export interface WritableKeyBackend {
  /** Persist base64 HMAC `material` under `keyId`. Overwrites if present. */
  putKeyMaterial(keyId: string, material: string): Promise<void>
  /** Read base64 HMAC material for `keyId`, or `null` if absent/revoked. */
  getKeyMaterial(keyId: string): Promise<string | null>
  /** Delete `keyId`'s material (revocation — the read provider then 401s it). */
  deleteKeyMaterial(keyId: string): Promise<void>
  /** Read a client's directory entry (current/previous keyIds), or `null` if unknown. */
  getDirectoryEntry(clientId: string): Promise<KeyDirectoryEntry | null>
  /** Persist a client's directory entry (the current→previous mapping). */
  putDirectoryEntry(clientId: string, entry: KeyDirectoryEntry): Promise<void>
  /**
   * Atomically create a client's directory entry only if none exists yet (NX).
   * Returns `true` when this call wrote the entry, `false` when one was already
   * present (no overwrite). Backs the atomic provision compare-and-set that
   * closes the provision TOCTOU (KEY-TOOL-05).
   */
  putDirectoryEntryIfAbsent(clientId: string, entry: KeyDirectoryEntry): Promise<boolean>
}

/** Options for {@link RedisKeyBackend}. */
export interface RedisKeyBackendOptions {
  /** Redis key prefix for stored material. Default `sh:signkey:`. */
  materialPrefix?: string
  /** Redis key prefix for client directory entries. Default `sh:keydir:`. */
  directoryPrefix?: string
}

/**
 * Redis-backed {@link WritableKeyBackend} over the structural {@link RedisPort}
 * (same port the stores use — no SDK import, ARCH-01). Key material is stored at
 * `${materialPrefix}${keyId}` and the client directory at
 * `${directoryPrefix}${clientId}` as a small JSON `{ current, previous? }`.
 *
 * A {@link NodeSecretProvider} reading this same Redis verifies the live keys:
 * point its {@link SecretSourceLike} at the same `materialPrefix` (see
 * {@link redisSecretSource}) and its `currentKeyByClient` is reflected by each
 * directory entry's `current`.
 */
export class RedisKeyBackend implements WritableKeyBackend {
  readonly #port: RedisPort
  readonly #materialPrefix: string
  readonly #directoryPrefix: string

  constructor(port: RedisPort, opts: RedisKeyBackendOptions = {}) {
    this.#port = port
    this.#materialPrefix = opts.materialPrefix ?? 'sh:signkey:'
    this.#directoryPrefix = opts.directoryPrefix ?? 'sh:keydir:'
  }

  async putKeyMaterial(keyId: string, material: string): Promise<void> {
    await this.#port.set(this.#materialPrefix + keyId, material)
  }

  async getKeyMaterial(keyId: string): Promise<string | null> {
    return this.#port.get(this.#materialPrefix + keyId)
  }

  async deleteKeyMaterial(keyId: string): Promise<void> {
    await this.#port.del(this.#materialPrefix + keyId)
  }

  async getDirectoryEntry(clientId: string): Promise<KeyDirectoryEntry | null> {
    const raw = await this.#port.get(this.#directoryPrefix + clientId)
    if (raw === null) return null
    return parseDirectoryEntry(raw, clientId)
  }

  async putDirectoryEntry(clientId: string, entry: KeyDirectoryEntry): Promise<void> {
    await this.#port.set(this.#directoryPrefix + clientId, JSON.stringify(entry))
  }

  async putDirectoryEntryIfAbsent(clientId: string, entry: KeyDirectoryEntry): Promise<boolean> {
    // `set ... NX` is atomic first-write-wins per the RedisPort contract — it
    // returns false (no write) when the key already exists, closing the
    // provision TOCTOU (KEY-TOOL-05).
    return this.#port.set(this.#directoryPrefix + clientId, JSON.stringify(entry), {
      ifNotExists: true,
    })
  }
}

/**
 * Build a read-only {@link SecretSourceLike} over the SAME Redis material the
 * {@link RedisKeyBackend} writes, so a live {@link NodeSecretProvider} verifies
 * exactly the keys the lifecycle tool provisioned/rotated. Use the same
 * `materialPrefix` on both. Returns `null` for a revoked/absent keyId (the
 * verifier then fails closed).
 */
export function redisSecretSource(
  port: RedisPort,
  opts: { materialPrefix?: string } = {},
): SecretSourceLike {
  const prefix = opts.materialPrefix ?? 'sh:signkey:'
  return {
    async get(keyId) {
      return port.get(prefix + keyId)
    },
  }
}
