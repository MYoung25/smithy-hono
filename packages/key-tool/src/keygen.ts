/**
 * HMAC secret generation + keyId minting (OPS-03).
 *
 * Web-standard only (`crypto.getRandomValues`, `btoa`) so the lifecycle library
 * stays portable — the only node-specific surface in this package is the CLI's
 * argv/stdout handling, not the crypto. Material is emitted as standard **base64**
 * (with padding), matching the encoding the Node/AWS read providers import.
 */

/** Default HMAC secret length in bytes. 32 bytes = 256 bits ≥ the SHA-256 block security level. */
export const DEFAULT_SECRET_BYTES = 32

/**
 * Minimum HMAC secret length in bytes (128-bit floor). A shorter key is trivially
 * brute-forceable from one observed signed request, so generation is rejected below
 * this regardless of caller (library or CLI). The {@link DEFAULT_SECRET_BYTES} of 32
 * is the recommended length; this is only the hard floor.
 */
export const MIN_SECRET_BYTES = 16

/** Encode raw bytes as standard base64 (with padding), no `node:Buffer` (ARCH-01-friendly). */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/**
 * Generate a fresh random HMAC secret and return it as base64 material. Uses
 * `crypto.getRandomValues` (CSPRNG). `byteLength` defaults to
 * {@link DEFAULT_SECRET_BYTES}.
 */
export function generateHmacSecret(byteLength: number = DEFAULT_SECRET_BYTES): string {
  if (!Number.isInteger(byteLength) || byteLength <= 0) {
    throw new RangeError('generateHmacSecret: byteLength must be a positive integer')
  }
  if (byteLength < MIN_SECRET_BYTES) {
    throw new RangeError(
      `generateHmacSecret: byteLength must be >= ${MIN_SECRET_BYTES} (128-bit floor); got ${byteLength}`,
    )
  }
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return bytesToBase64(bytes)
}

/**
 * Mint a keyId for a client. Format: `<clientId>.<shortToken>` — the clientId
 * prefix makes a keyId self-describing in logs/audit, and the random suffix makes
 * each rotation's keyId unique (so current/previous never collide). The keyId is
 * NON-secret (it travels in the `Authorization` header); only the material is
 * secret. `tokenBytes` defaults to 6 (→ 12 hex chars).
 */
export function mintKeyId(clientId: string, tokenBytes = 6): string {
  const bytes = new Uint8Array(tokenBytes)
  crypto.getRandomValues(bytes)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return `${clientId}.${hex}`
}
