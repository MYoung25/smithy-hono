/**
 * Typed Hono context variables the pipeline populates (ARCH-07).
 *
 * The pre-deserialization pipeline phases set a small, fixed set of variables on
 * the Hono context that downstream phases, the generated `authorize` hook, and the
 * application handler read. Declaring the shape here gives `c.get('principal')`,
 * `c.get('session')` and `c.get('requestId')` real types instead of `unknown`.
 *
 * Phases S3–S9 populate these (e.g. `authenticate` sets `principal`/`session` in
 * S5, the logger sets `requestId` in S9); in this skeleton phase the placeholders
 * are pass-throughs, so the variables are simply declared and left unset.
 */

import type { Principal, SessionRecord } from '../storage/index.js'

/**
 * The variables the security pipeline writes onto the Hono context. A generated
 * service uses this as its `Env['Variables']` so handlers and the `authorize`
 * hook get typed accessors.
 */
export interface SecurityVariables {
  /** Set by `authenticate` (S5) once a session/token resolves to an identity. */
  principal: Principal
  /** The loaded session record (S5) — CSRF (S8) reads `session.csrfToken` for free. */
  session: SessionRecord
  /** Correlation id minted by the request-id phase (S9). */
  requestId: string
  /**
   * The resource loaded by `requireResourcePolicy` (S5b) on an `allow` decision,
   * stashed under `RESOURCE_CONTEXT_KEY` so the handler reuses it without a second
   * fetch (AUTHZ-03). Untyped (`unknown`) because the resource shape is per-op.
   */
  resource?: unknown
}

/** The Hono `Env` a service mounting the pipeline should parameterize on. */
export interface SecurityEnv {
  Variables: SecurityVariables
}
