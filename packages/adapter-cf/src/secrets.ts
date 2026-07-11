/**
 * {@link SecretProvider} over a Workers env secret binding (SIGN-05/06).
 *
 * Keys never live in code or config (SIGN-06) — the consumer passes a structural
 * record of raw HMAC key material drawn from `env` (Workers secrets are exposed
 * as string properties on the per-request `env`). This provider imports each into
 * a non-extractable Web-standard {@link CryptoKey} for HMAC-SHA-256 verification
 * (ARCH-01) and resolves the current key ID per client via an injected map.
 *
 * KEY ENCODING: raw key material is **hex** (lowercase, even length). Chosen over
 * base64 to avoid base64url/standard ambiguity. See {@link hexToBytes}.
 */

import type { SecretProvider } from '@smithy-hono/security-core/storage'

/**
 * A structural record of `keyId -> hex-encoded HMAC secret`. In production this is
 * assembled from the Workers `env` secret bindings in the request entrypoint and
 * passed in — the raw material is read from secrets, never embedded (SIGN-06).
 */
export type SecretMaterialMap = Record<string, string>

/** `clientId -> current keyId` for {@link SecretProvider.getCurrentKeyId}. */
export type CurrentKeyByClient = Record<string, string>

/** Decode a lowercase hex string to bytes. Throws on malformed input. */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim()
  if (clean.length === 0 || clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error('SecretProvider: key material must be even-length hex')
  }
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

async function importHmacKey(hexMaterial: string): Promise<CryptoKey> {
  const bytes = hexToBytes(hexMaterial)
  return crypto.subtle.importKey(
    'raw',
    bytes as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false, // non-extractable (SIGN-06)
    ['verify'],
  )
}

/**
 * Env-backed {@link SecretProvider}. Keys are imported lazily on first use and
 * cached as `CryptoKey`s for the lifetime of the provider instance (one request
 * scope on Workers).
 */
export class EnvSecretProvider implements SecretProvider {
  private readonly imported = new Map<string, Promise<CryptoKey>>()

  constructor(
    private readonly material: SecretMaterialMap,
    private readonly currentKeyByClient: CurrentKeyByClient,
  ) {}

  async getSigningKey(keyId: string): Promise<CryptoKey | null> {
    const hex = this.material[keyId]
    if (hex === undefined) return null
    let pending = this.imported.get(keyId)
    if (!pending) {
      pending = importHmacKey(hex)
      this.imported.set(keyId, pending)
    }
    try {
      return await pending
    } catch (err) {
      // Drop the bad cache entry so a corrected binding can recover.
      this.imported.delete(keyId)
      throw err
    }
  }

  async getCurrentKeyId(clientId: string): Promise<string> {
    const id = this.currentKeyByClient[clientId]
    if (id === undefined) {
      throw new Error(`No current signing key registered for client '${clientId}'`)
    }
    return id
  }
}

// ===========================================================================
// OPS-03 — key LIFECYCLE write backend (STUB for Cloudflare).
//
// On Workers, signing-key MATERIAL is a Workers *secret* (`wrangler secret put`)
// and is deliberately NOT writable at request time from inside the Worker — the
// runtime exposes secrets as read-only `env` bindings. So a Workers key backend is
// inherently TWO planes:
//
//   1. MATERIAL plane (out-of-band): provisioning/rotating/revoking key material
//      is a control-plane action via `wrangler secret put/delete <NAME>` or the
//      Cloudflare API (`PUT /accounts/:id/workers/scripts/:script/secrets`). This
//      cannot be done from the data-plane Worker and is therefore an operator/CI
//      step — see `docs/key-lifecycle.md` ("Cloudflare").
//   2. DIRECTORY plane (in-band): the client→keyId map (current/previous) CAN live
//      in Workers KV and be mutated at runtime — that part maps cleanly onto a
//      `WritableKeyBackend`-style implementation over `KvNamespaceLike`.
//
// The node adapter ships the full end-to-end backend (Redis holds BOTH material and
// directory). Here we expose the directory-plane writer and document the material
// plane as an out-of-band `wrangler`/API call rather than pretend the Worker can
// write its own secrets. `getKeyMaterial` reads the injected env material map;
// `putKeyMaterial`/`deleteKeyMaterial` throw with the out-of-band instruction.
// ===========================================================================

/** A client's current/previous keyId mapping (the directory plane). */
export interface CfKeyDirectoryEntry {
  current: string
  previous?: string
}

/**
 * Parse a stored directory entry, failing CLOSED on a corrupt or wrong-shaped
 * value. Workers KV is writable out-of-band, so a malformed JSON value (raw
 * `SyntaxError`) or a valid-but-shapeless one (`current` missing/non-string) must
 * surface as a descriptive, namespaced error rather than letting `undefined` flow
 * downstream into pointer writes.
 */
function parseCfDirectoryEntry(raw: string, clientId: string): CfKeyDirectoryEntry {
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
  return parsed as CfKeyDirectoryEntry
}

/** Minimal KV surface for the directory plane (subset of `KvNamespaceLike`). */
export interface KvDirectoryLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
}

/**
 * Cloudflare key-lifecycle backend. The DIRECTORY plane (client→keyId) is fully
 * writable in Workers KV; the MATERIAL plane is read-only here by design (Workers
 * secrets are provisioned out-of-band via `wrangler secret put`/the Cloudflare
 * API). The lifecycle tool can rotate the *directory pointer* in-band but must be
 * told the new material was already published out-of-band (it cannot write it).
 */
export class CfKeyBackend {
  constructor(
    private readonly material: SecretMaterialMap,
    private readonly kv: KvDirectoryLike,
    private readonly directoryPrefix = 'sh:keydir:',
  ) {}

  async getKeyMaterial(keyId: string): Promise<string | null> {
    return this.material[keyId] ?? null
  }

  async putKeyMaterial(_keyId: string, _material: string): Promise<void> {
    throw new Error(
      'CfKeyBackend: Workers secrets are read-only at runtime — publish key material ' +
        'out-of-band with `wrangler secret put SIGNING_KEY_<keyId>` or the Cloudflare ' +
        'API, then rotate the directory pointer. See docs/key-lifecycle.md (Cloudflare).',
    )
  }

  async deleteKeyMaterial(_keyId: string): Promise<void> {
    throw new Error(
      'CfKeyBackend: revoke key material out-of-band with `wrangler secret delete ' +
        'SIGNING_KEY_<keyId>` or the Cloudflare API. See docs/key-lifecycle.md (Cloudflare).',
    )
  }

  async getDirectoryEntry(clientId: string): Promise<CfKeyDirectoryEntry | null> {
    const raw = await this.kv.get(this.directoryPrefix + clientId)
    return raw === null ? null : parseCfDirectoryEntry(raw, clientId)
  }

  async putDirectoryEntry(clientId: string, entry: CfKeyDirectoryEntry): Promise<void> {
    await this.kv.put(this.directoryPrefix + clientId, JSON.stringify(entry))
  }
}
