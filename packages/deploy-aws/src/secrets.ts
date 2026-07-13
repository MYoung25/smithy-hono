/**
 * Secret-material generation for the deploy CLI. Mirrors `@smithy-hono/deploy-cf`'s
 * `materializeSecret`, but sources bytes from node's own CSPRNG (`node:crypto`
 * `randomBytes`) rather than `@smithy-hono/key-tool` — this package is a
 * node-only CLI, so a node built-in keeps the dependency surface minimal.
 *
 * ENCODING NOTE: `hmac-hex` produces lowercase hex (what an HMAC `EnvSecretProvider`
 * that expects hex key material requires); the base64 variants produce standard,
 * padded base64. base64↔hex conversions are exact and lossless.
 */
import { randomBytes } from 'node:crypto'
import type { SecretSpec } from './config.js'

/** Convert standard base64 (with padding) to lowercase hex. */
export function base64ToHex(b64: string): string {
  return Buffer.from(b64, 'base64').toString('hex')
}

/**
 * Produce the material for one secret spec. For `generate` specs the bytes come
 * from `node:crypto`'s CSPRNG; for `from: 'secretsFile'` the value is looked up
 * in `fileValues` (the parsed secrets file), throwing a clear error if absent.
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
