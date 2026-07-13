/**
 * Secret-material generation for the deploy CLI. Uses node's built-in CSPRNG
 * (`node:crypto` `randomBytes`) as the single source of key material — no external
 * dependency — mirroring `@smithy-hono/deploy-cf`'s `materializeSecret`.
 *
 * ENCODING NOTE: the Node `EnvSecretProvider` wants HMAC key material as lowercase
 * hex, so `hmac-hex` hex-encodes the random bytes; `hmac-base64` / `random-base64`
 * base64-encode them.
 */
import { randomBytes } from 'node:crypto'
import type { SecretSpec } from './config.js'

/**
 * Produce the material for one secret spec. For `generate` specs the bytes come
 * from node's CSPRNG; for `from: 'secretsFile'` the value is looked up in
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
  const buf = randomBytes(spec.bytes ?? 32)
  switch (spec.generate) {
    case 'hmac-hex':
      return buf.toString('hex')
    case 'hmac-base64':
    case 'random-base64':
      return buf.toString('base64')
    default: {
      // Exhaustiveness guard.
      const never: never = spec.generate
      throw new Error(`Unknown secret generator: ${String(never)}`)
    }
  }
}
