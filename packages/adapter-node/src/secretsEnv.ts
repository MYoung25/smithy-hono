/**
 * Env-backed {@link SecretSourceLike} convenience factory — ISOLATED here.
 *
 * This is the ONE place in the package that reads `process.env`. Core store /
 * provider logic never touches env (ARCH-05); a deployment that prefers env vars
 * over a mounted-secret loader opts in by calling {@link envSecretSource}.
 *
 * Each key is read from `${prefix}${keyId}` (default prefix `SIGNING_KEY_`),
 * holding the **base64-encoded** raw HMAC bytes (same encoding as the rest of the
 * package). Key IDs are normalized to an env-safe form (uppercased, non
 * `[A-Z0-9_]` → `_`) so a keyId like `client-a.v2` maps to `SIGNING_KEY_CLIENT_A_V2`.
 *
 * COLLISION HAZARD: the normalization is lossy and many-to-one — `client-a.v2`,
 * `client.a.v2`, and `Client-A-V2` all collapse to `SIGNING_KEY_CLIENT_A_V2`. Two
 * DISTINCT logical keyIds that normalize to the same env name would silently share
 * material (key confusion). This source guards against that WITHIN A SINGLE
 * long-lived source instance: the FIRST keyId seen for a normalized name owns it,
 * and a later DIFFERENT keyId producing the same name FAILS CLOSED (throws) rather
 * than verifying against the wrong material. NOTE: the guard is per-instance state,
 * so under a per-request instantiation model (a fresh `envSecretSource` per request
 * with an injected env) two colliding keyIds never coexist in one instance and the
 * throw cannot fire — a single env var can only ever hold one material regardless.
 * Choose keyIds that stay distinct after `toUpperCase()` + `[^A-Z0-9_]→_`, or use
 * `redisSecretSource` / `recordSecretSource` for verbatim arbitrary keyId schemes.
 */

import type { SecretSourceLike } from './secrets.js'

/** Minimal structural view of `process.env` (no @types/node dependency). */
interface ProcessEnvLike {
  env: Record<string, string | undefined>
}

declare const process: ProcessEnvLike

function envName(prefix: string, keyId: string): string {
  return prefix + keyId.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
}

export interface EnvSecretSourceOptions {
  /** Env-var name prefix. Default `SIGNING_KEY_`. */
  prefix?: string
  /**
   * Inject an explicit env map (e.g. the per-request Workers env, or for tests).
   * Defaults to the ambient `process.env`. This is the only `process.env` read
   * in the package and it happens lazily, per `get`, never at module load.
   */
  env?: Record<string, string | undefined>
}

/**
 * Build a {@link SecretSourceLike} reading base64 HMAC material from environment
 * variables. The env map is captured at call time; reads happen per `get`.
 */
export function envSecretSource(opts: EnvSecretSourceOptions = {}): SecretSourceLike {
  const prefix = opts.prefix ?? 'SIGNING_KEY_'
  const env = opts.env ?? process.env
  // Track which original keyId first claimed each normalized env name so that a
  // SECOND, distinct keyId colliding onto the same name fails closed (key
  // confusion guard) instead of silently resolving the other key's material.
  const claimedBy = new Map<string, string>()
  return {
    async get(keyId) {
      const name = envName(prefix, keyId)
      // Read the env var FIRST and bail on a miss so `claimedBy` only ever records
      // keyIds that resolve to a REAL env var. This bounds the guard map by the
      // number of configured SIGNING_KEY_* vars (operator-controlled) instead of
      // letting an attacker grow it one entry per distinct unresolved keyId (DoS).
      const val = env[name]
      if (val === undefined) return null
      const owner = claimedBy.get(name)
      if (owner === undefined) {
        claimedBy.set(name, keyId)
      } else if (owner !== keyId) {
        throw new Error(
          `envSecretSource: keyId '${keyId}' normalizes to env var '${name}', which ` +
            `already maps to distinct keyId '${owner}' (key-confusion collision). ` +
            `Choose keyIds distinct after uppercasing + non-[A-Z0-9_]→_, or use ` +
            `redisSecretSource/recordSecretSource for verbatim keyIds.`,
        )
      }
      return val
    },
  }
}
