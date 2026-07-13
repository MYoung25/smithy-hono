/**
 * `@smithy-hono/key-tool` — S2S signing-key lifecycle library + CLI (OPS-03).
 *
 * Provisions, rotates (with an overlap window), and revokes a client's HMAC
 * signing key against any runtime adapter's WRITE backend (Redis / Secrets
 * Manager / Workers-KV directory), and emits `key.rotate` audit events on
 * rotation. The lifecycle functions are backend-agnostic (they drive the
 * structural {@link WritableKeyBackend}); the per-adapter concrete backends live
 * in `@smithy-hono/adapter-{node,aws,cf}`.
 *
 * See `docs/key-lifecycle.md` for the operator runbook (onboarding, the overlap
 * window, revocation) and the `key-tool` CLI usage.
 */

export type { WritableKeyBackend, KeyDirectoryEntry } from './backend.js'

export {
  generateHmacSecret,
  mintKeyId,
  bytesToBase64,
  DEFAULT_SECRET_BYTES,
  MIN_SECRET_BYTES,
} from './keygen.js'

export {
  provisionClient,
  rotateClient,
  revokePreviousKey,
  revokeClient,
  type LifecycleAudit,
  type ProvisionInput,
  type ProvisionResult,
  type RotateInput,
  type RotateResult,
} from './lifecycle.js'
