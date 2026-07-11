/**
 * Operation-tier authorization (AUTHZ-01/02) — the post-deserialization hook the
 * codegen emits into every protected route.
 *
 * `authorize(OPERATIONS.<Op>)` runs after constraint validation (Zod) and the
 * app's per-operation middleware, immediately before the handler. It reads the
 * `Principal` that the pipeline's `authenticate` phase (S5) placed on the context
 * and enforces the operation's `requiredPermissions` deny-by-default:
 *
 *  - no principal            → uniform 401 (AUTH-10) — auth never ran or failed open
 *  - missing a permission    → 403 `AccessDenied`   (AUTHZ-02)
 *  - all permissions present → `next()`
 *
 * Resource-level ("may this principal act on *this* row?") authZ is a separate
 * concern that rides the per-operation middleware slot via `requireResourcePolicy`
 * (Phase S5b); this hook is only the coarse operation/permission gate.
 */

import type { MiddlewareHandler } from 'hono'
import type { Principal } from '../storage/index.js'

/**
 * The slice of the codegen-emitted `OperationMeta` (registry.gen.ts) this hook
 * needs. Declared structurally so `security-core` never imports generated code —
 * the generated `OperationMeta` is assignable to it.
 */
export interface AuthorizableOperation {
  /** Operation name, for audit/log context (LOG-10, wired in S9). */
  name: string
  /** Permission scopes the principal MUST hold in full (AUTHZ-01). */
  requiredPermissions: string[]
  /**
   * Optional caller-kind allow-list (AUTHZ-03). When present, the principal's
   * `kind` MUST be one of these or the op is denied with 403 — a first-class lever
   * to segregate user vs. service callers at the operation tier even when they
   * share a permission scope. Absent (the default) preserves the prior behavior:
   * any authenticated principal of any kind that holds `requiredPermissions` passes.
   */
  allowedPrincipalKinds?: Principal['kind'][]
}

/** Uniform 401 — one body for every missing/expired/invalid case (AUTH-10). */
function uniform401(): Response {
  return Response.json({ code: 'Unauthorized' }, { status: 401 })
}

/**
 * Build the operation-tier authZ middleware for `op`. Emitted by codegen as
 * `authorize(OPERATIONS.<Op>)` for every op with `requiredPermissions` or a
 * non-anonymous auth scheme.
 */
export function authorize(op: AuthorizableOperation): MiddlewareHandler {
  return async (c, next) => {
    const principal = c.get('principal') as Principal | undefined
    if (!principal) return uniform401()
    // AUTHZ-03 — when the op restricts caller kind, a principal of a disallowed kind
    // is denied even if it holds every required permission (e.g. a service key on a
    // user-only op). Absent allow-list ⇒ no kind restriction (non-breaking default).
    if (
      op.allowedPrincipalKinds !== undefined &&
      !op.allowedPrincipalKinds.includes(principal.kind)
    ) {
      return c.json({ code: 'AccessDenied' }, 403)
    }
    const ok = op.requiredPermissions.every((perm) =>
      principal.permissions.includes(perm),
    )
    if (!ok) return c.json({ code: 'AccessDenied' }, 403)
    await next()
  }
}
