/**
 * Secret-material generation for the deploy CLI. Reuses `@smithy-hono/key-tool`'s
 * web-standard CSPRNG (`generateHmacSecret`, base64) as the single source of key
 * material, and converts to hex where the consumer requires it.
 *
 * ENCODING NOTE: the CF `EnvSecretProvider` requires HMAC key material as
 * lowercase hex, but key-tool mints base64 — so `hmac-hex` converts. base64→hex
 * is exact and lossless.
 */
import { generateHmacSecret } from '@smithy-hono/key-tool'
import type { SecretSpec } from './config.js'

/** Convert standard base64 (with padding) to lowercase hex. */
export function base64ToHex(b64: string): string {
  return Buffer.from(b64, 'base64').toString('hex')
}

/**
 * Produce the material for one secret spec. For `generate` specs the bytes come
 * from key-tool's CSPRNG; for `from: 'secretsFile'` the value is looked up in
 * `fileValues` (the parsed secrets file), throwing a clear error if absent.
 */
export function materializeSecret(
  spec: SecretSpec,
  fileValues: Record<string, string>,
): string {
  if ('from' in spec) {
    const v = fileValues[spec.name]
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(
        `Secret "${spec.name}" is declared as { from: 'secretsFile' } but is missing ` +
          `or empty in the secrets file. Add it (e.g. an IdP client secret) and re-run.`,
      )
    }
    return v
  }
  const b64 = generateHmacSecret(spec.bytes ?? 32)
  switch (spec.generate) {
    case 'hmac-hex':
      return base64ToHex(b64)
    case 'hmac-base64':
    case 'random-base64':
      return b64
    default: {
      // Exhaustiveness guard.
      const never: never = spec.generate
      throw new Error(`Unknown secret generator: ${String(never)}`)
    }
  }
}
