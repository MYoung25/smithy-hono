/**
 * Resource-tier authorization (Phase S5b, AUTHZ-03/05/06/07) — the second of the
 * two-tier authZ model. Where {@link ../pipeline/authorize.authorize} answers the
 * coarse "may this principal call this *operation*?" (permission scopes,
 * deny-by-default), this answers the fine "may this principal act on *this*
 * resource?" — which needs the resource, so it runs **after** validation in the
 * per-operation middleware slot (`plan/12-extensible-middleware.md`).
 *
 * There is NO codegen for this tier (AUTHZ-09): it is plain TypeScript that rides
 * the existing generated per-operation middleware slot — an app drops
 * `requireResourcePolicy(...)` into that slot just like any other Hono middleware.
 *
 * Web-standard only (ARCH-01): no `node:*`, no `Buffer`, no module-level env reads.
 * Core never imports generated code — the operation shape it reads is declared
 * structurally (see {@link AuthorizedOperationMeta}), exactly as `authorize.ts`
 * does, so the generated `OperationMeta` is assignable to it.
 *
 * ## The seam — `ResourcePolicy`
 *
 * A {@link ResourcePolicy} is the pluggable decision unit (mirrors the ARCH-03
 * storage adapters). The framework ships zero-dep ABAC helpers ({@link isOwner},
 * {@link sameTenant}, {@link all}, {@link any}) covering the ~90% case, but the
 * interface is the real product: a project that outgrows ABAC implements
 * `check()` as a call to a relationship engine (OpenFGA / Cedar) behind the **same
 * interface, no framework change** — see the ReBAC seam note below.
 *
 * ## No double fetch (AUTHZ-03)
 *
 * The app supplies a resource loader (`opts.load`); `requireResourcePolicy`
 * wraps it in a **memoizing thunk** so the policy's `ctx.load()` and the later
 * handler's read of `c.get('resource')` share a single fetch. Composed policies
 * ({@link all} / {@link any}) thread the *same* {@link PolicyContext}, so even a
 * stack of policies fetches the resource at most once.
 *
 * @module
 */

import type { Context, MiddlewareHandler } from 'hono'
// Type-only — core never depends on storage/generated code at runtime (ARCH-01).
import type { Principal } from '../storage/index.js'

// ---------------------------------------------------------------------------
// Structural operation shape (so core never imports generated code).
// ---------------------------------------------------------------------------

/**
 * The slice of the codegen-emitted `OperationMeta` (registry.gen.ts) a resource
 * policy might read, declared structurally so `security-core` never imports
 * generated code — the generated `OperationMeta` is assignable to it. Mirrors
 * `authorize.ts`'s {@link ../pipeline/authorize.AuthorizableOperation}, plus the
 * registry's `readonly` flag (a policy may relax checks for read-only ops).
 */
export interface AuthorizedOperationMeta {
  /** Operation name, for audit/log context (LOG-10) and policy branching. */
  name: string
  /** Whether the op only reads (registry `readonly`); a policy may use this to relax. */
  readonly: boolean
  /** Permission scopes required by the operation tier (AUTHZ-01) — informational here. */
  requiredPermissions: string[]
}

// ---------------------------------------------------------------------------
// Policy interfaces.
// ---------------------------------------------------------------------------

/**
 * The per-request context a {@link ResourcePolicy} decides against.
 *
 * `operation` is optional because the plan's wiring example
 * (`requireResourcePolicy(all(sameTenant(), isOwner()))`) passes no op, and the
 * ABAC helpers ({@link isOwner} / {@link sameTenant}) do not read it. Provide it
 * via `opts.operation` when a policy needs to branch on the op (e.g. relax for
 * `readonly`).
 */
export interface PolicyContext {
  /** The op being authorized, when supplied via `opts.operation`. Optional (see above). */
  operation?: AuthorizedOperationMeta
  /** The validated input (`c.req.valid(...)`) — typed id(s) the policy keys off. */
  input: unknown
  /**
   * The app-provided resource loader, **memoized** (AUTHZ-03): calling it any
   * number of times across composed policies + the handler triggers at most one
   * underlying fetch. Resolves `null` when the resource does not exist.
   */
  load: <T>() => Promise<T | null>
}

/**
 * A policy's verdict.
 *
 * - `allow: true` — optionally hand the loaded `resource` back so the handler
 *   reuses it (no second fetch, AUTHZ-03).
 * - `allow: false` — `reason` drives the HTTP status (AUTHZ-06): `forbidden` →
 *   `403`, `notFound` → `404` for resources whose very existence is sensitive.
 */
export type PolicyDecision =
  | { allow: true; resource?: unknown }
  | { allow: false; reason: 'forbidden' | 'notFound' }

/**
 * The pluggable resource-authorization decision unit (mirrors ARCH-03 storage
 * adapters). The framework ships ABAC implementations; an app may supply its own
 * — notably a ReBAC adapter (see the seam note at the bottom of this file).
 */
export interface ResourcePolicy {
  check(principal: Principal, ctx: PolicyContext): Promise<PolicyDecision>
}

// ---------------------------------------------------------------------------
// requireResourcePolicy — the per-op middleware slot entry point.
// ---------------------------------------------------------------------------

/**
 * Context key under which {@link requireResourcePolicy} stashes the loaded
 * resource on `allow: true` so the handler reads it without re-fetching
 * (AUTHZ-03). The integrator may add `resource?: unknown` to `SecurityVariables`
 * so `c.get(RESOURCE_CONTEXT_KEY)` is typed; the default key is `'resource'`.
 */
export const RESOURCE_CONTEXT_KEY = 'resource' as const

/** Options for {@link requireResourcePolicy}. */
export interface RequireResourcePolicyOptions {
  /**
   * The app's resource loader. Wrapped in a memoizing thunk and exposed as
   * `ctx.load()` (AUTHZ-03). Omit for policies that never load (pure-input ABAC
   * / a ReBAC engine that keys off `ctx.input`) — then `ctx.load()` resolves
   * `null`.
   */
  load?: (c: Context) => Promise<unknown>
  /** Context key to stash the loaded resource under. Default {@link RESOURCE_CONTEXT_KEY}. */
  resourceKey?: string
  /**
   * How to derive the policy's `input`. Defaults to the validated json body, then
   * the validated path params (`c.req.valid('json') ?? c.req.valid('param')`),
   * available because this runs AFTER `zValidator` in the per-op slot.
   */
  input?: (c: Context) => unknown
  /** The op meta, surfaced on `ctx.operation` for policies that branch on it. */
  operation?: AuthorizedOperationMeta
}

/** Uniform 401 — one body for every missing/expired/invalid case (AUTH-10). */
function uniform401(): Response {
  return Response.json({ code: 'Unauthorized' }, { status: 401 })
}

/**
 * Read the validated input the policy keys off. Defaults to `valid('json')` then
 * `valid('param')`; `c.req.valid` throws if the target was never validated, so
 * each probe is guarded and treated as "not present".
 */
function defaultInput(c: Context): unknown {
  const tryTarget = (target: string): unknown => {
    try {
      // `valid` is only typed for validated targets; probe defensively.
      return (c.req.valid as (t: string) => unknown)(target)
    } catch {
      return undefined
    }
  }
  return tryTarget('json') ?? tryTarget('param')
}

/**
 * Build a resource-tier authZ middleware for the per-operation slot.
 *
 * Signature is **policy-first** (`requireResourcePolicy(policy, opts?)`) to match
 * the plan's wiring example verbatim — the op, when a policy needs it, is passed
 * via `opts.operation`. Dropped into the generated per-op slot it:
 *
 *  1. reads the authenticated `Principal` (`c.get('principal')`, set by S5);
 *     absent → uniform 401 (auth should have run; fail closed, mirrors
 *     `authorize.ts`);
 *  2. builds a {@link PolicyContext} with the validated `input` and a **memoized**
 *     `load` thunk (AUTHZ-03);
 *  3. runs `policy.check(principal, ctx)`;
 *  4. on `allow: true` stashes the resource (the decision's `resource`, else the
 *     memoized load if it ran) under `opts.resourceKey` so the handler reuses it,
 *     then `next()`;
 *  5. on `allow: false` maps `notFound` → `404 {code:'NotFound'}`, `forbidden` →
 *     `403 {code:'AccessDenied'}` (AUTHZ-06; the 403 body matches `authorize.ts`).
 *
 * Wiring (mirrors the generated per-op slot):
 * ```ts
 * createTodoRouter(ops, {
 *   GetTodo:    [requireResourcePolicy(all(sameTenant(), isOwner()), { load: (c) => db.todo(c.req.valid('param').id) })],
 *   UpdateTodo: [requireResourcePolicy(isOwner(), { load: (c) => db.todo(c.req.valid('param').id), operation: OPERATIONS.UpdateTodo })],
 * })
 * ```
 */
export function requireResourcePolicy(
  policy: ResourcePolicy,
  opts: RequireResourcePolicyOptions = {},
): MiddlewareHandler {
  const resourceKey = opts.resourceKey ?? RESOURCE_CONTEXT_KEY

  const handler: MiddlewareHandler = async (c, next) => {
    const principal = c.get('principal') as Principal | undefined
    // Auth should already have run in S5; a missing principal is fail-closed 401.
    if (!principal) return uniform401()

    const input = opts.input ? opts.input(c) : defaultInput(c)

    // Memoize the app's loader so policy + handler share ONE fetch (AUTHZ-03).
    // We cache the *promise* (not the resolved value) so concurrent calls within
    // a single request also coalesce onto the first in-flight fetch.
    let loadPromise: Promise<unknown> | undefined
    let loadInvoked = false
    const load = (<T>(): Promise<T | null> => {
      if (!loadPromise) {
        loadInvoked = true
        loadPromise = opts.load ? opts.load(c) : Promise.resolve(null)
      }
      return loadPromise as Promise<T | null>
    }) as PolicyContext['load']

    const ctx: PolicyContext = { operation: opts.operation, input, load }

    const decision = await policy.check(principal, ctx)

    if (decision.allow) {
      // Prefer the resource the policy explicitly passed back; otherwise reuse the
      // already-memoized load result if the policy triggered it — either way the
      // handler reads it from context instead of fetching again (AUTHZ-03).
      let resource = decision.resource
      if (resource === undefined && loadInvoked) {
        resource = await loadPromise
      }
      if (resource !== undefined && resource !== null) {
        c.set(resourceKey, resource as never)
      }
      await next()
      return
    }

    // AUTHZ-06 — existence-sensitive resources hide behind 404; everything else 403.
    if (decision.reason === 'notFound') {
      return c.json({ code: 'NotFound' }, 404)
    }
    return c.json({ code: 'AccessDenied' }, 403)
  }

  Object.defineProperty(handler, 'name', { value: 'requireResourcePolicy' })
  return handler
}

// ---------------------------------------------------------------------------
// ABAC helper policies (zero-dep, Web-standard).
// ---------------------------------------------------------------------------

/** Read `field` off a loaded resource without assuming its concrete type. */
function readField(resource: unknown, field: string): unknown {
  if (resource === null || typeof resource !== 'object') return undefined
  return (resource as Record<string, unknown>)[field]
}

/**
 * Ownership ABAC (the common case): allow iff the loaded resource's `field`
 * equals the principal's `id`. A missing resource (`load() → null`) yields
 * `notFound` so the caller can render a 404 for existence-sensitive rows
 * (AUTHZ-06); a present-but-not-owned resource yields `forbidden` → 403.
 *
 * @param field resource property holding the owner id. Default `'ownerId'`.
 */
export const isOwner = (field = 'ownerId'): ResourcePolicy => ({
  async check(principal, ctx) {
    const resource = await ctx.load()
    if (resource === null || resource === undefined) {
      return { allow: false, reason: 'notFound' }
    }
    if (readField(resource, field) === principal.id) {
      return { allow: true, resource }
    }
    return { allow: false, reason: 'forbidden' }
  },
})

/** Tenant-isolation behaviour when the principal carries no `tenantId`. */
export interface SameTenantOptions {
  /**
   * What to do when `principal.tenantId` is unset:
   * - `'deny'` (**default**) — fail closed; correct for multi-tenant deployments
   *   where an untenanted principal must never reach a tenanted resource.
   * - `'allow'` — single-tenant mode; the tenant dimension is unused, so pass.
   *
   * Note: when the *resource* carries no tenant field either, the comparison is
   * vacuous (`undefined === undefined`) and allows regardless of this setting —
   * isolation only bites once resources are actually tenanted.
   */
  onMissingTenant?: 'allow' | 'deny'
}

/**
 * Tenant-isolation ABAC (AUTHZ-07): allow iff `principal.tenantId` equals the
 * resource's `field`. When the principal has no `tenantId`, behaviour is
 * configurable via {@link SameTenantOptions.onMissingTenant} and defaults to
 * `'deny'` (multi-tenant fail-closed). A missing resource yields `notFound`
 * (AUTHZ-06); a cross-tenant resource yields `forbidden` → 403, denying access
 * even when the principal holds the operation permission (AUTHZ-07).
 *
 * @param field resource property holding the tenant id. Default `'tenantId'`.
 */
export const sameTenant = (
  field = 'tenantId',
  opts: SameTenantOptions = {},
): ResourcePolicy => {
  const onMissingTenant = opts.onMissingTenant ?? 'deny'
  return {
    async check(principal, ctx) {
      const resource = await ctx.load()
      if (resource === null || resource === undefined) {
        return { allow: false, reason: 'notFound' }
      }
      if (principal.tenantId === undefined) {
        return onMissingTenant === 'allow'
          ? { allow: true, resource }
          : { allow: false, reason: 'forbidden' }
      }
      if (readField(resource, field) === principal.tenantId) {
        return { allow: true, resource }
      }
      return { allow: false, reason: 'forbidden' }
    },
  }
}

/**
 * Combinator: AND. Allows iff **every** policy allows; denies on the first deny,
 * propagating that policy's `reason` (so a `notFound` short-circuits to 404). The
 * **same** {@link PolicyContext} is threaded to each policy, so the memoized
 * `load` fetches the resource at most once across the whole stack (AUTHZ-03). On
 * full allow, the last allowing decision's `resource` (if any) is carried out.
 */
export const all = (...policies: ResourcePolicy[]): ResourcePolicy => ({
  async check(principal, ctx) {
    let resource: unknown
    for (const policy of policies) {
      const decision = await policy.check(principal, ctx)
      if (!decision.allow) return decision
      if (decision.resource !== undefined) resource = decision.resource
    }
    return resource !== undefined ? { allow: true, resource } : { allow: true }
  },
})

/**
 * Combinator: OR. Allows on the **first** allowing policy (carrying its
 * `resource`). If all deny, returns a single deny: `notFound` only when *every*
 * branch was `notFound` (the resource genuinely is absent), otherwise `forbidden`
 * (prefer not to leak existence when at least one branch saw the resource). The
 * same {@link PolicyContext} is threaded so `load` runs at most once (AUTHZ-03).
 */
export const any = (...policies: ResourcePolicy[]): ResourcePolicy => ({
  async check(principal, ctx) {
    let sawForbidden = false
    for (const policy of policies) {
      const decision = await policy.check(principal, ctx)
      if (decision.allow) return decision
      if (decision.reason !== 'notFound') sawForbidden = true
    }
    return { allow: false, reason: sawForbidden ? 'forbidden' : 'notFound' }
  },
})

// ---------------------------------------------------------------------------
// ReBAC adapter seam (OpenFGA / Cedar) — documentation only.
// ---------------------------------------------------------------------------

/*
 * For graph / hierarchical sharing (org → team → folder → doc, "shared with"),
 * a project escalates from ABAC to a relationship engine by implementing the
 * SAME {@link ResourcePolicy} interface — no `security-core` change, and no
 * OpenFGA/Cedar dependency is bundled here (ARCH-01/04). The adapter is app code:
 *
 * ```ts
 * // app code — depends on the engine SDK, not on security-core depending on it.
 * function createOpenFgaPolicy(cfg: {
 *   check: (req: { user: string; relation: string; object: string }) => Promise<boolean>
 *   relation: string
 *   object: (ctx: PolicyContext) => string   // e.g. (ctx) => `doc:${(ctx.input as { id: string }).id}`
 * }): ResourcePolicy {
 *   return {
 *     async check(principal, ctx) {
 *       const ok = await cfg.check({
 *         user: `user:${principal.id}`,
 *         relation: cfg.relation,
 *         object: cfg.object(ctx),
 *       })
 *       return ok ? { allow: true } : { allow: false, reason: 'forbidden' }
 *     },
 *   }
 * }
 *
 * // wiring is identical to the ABAC case:
 * createDocRouter(ops, { GetDoc: [requireResourcePolicy(createOpenFgaPolicy(fga))] })
 * ```
 *
 * The engine call replaces the ABAC predicate; existence-sensitive objects can
 * still return `{ allow: false, reason: 'notFound' }` to drive a 404 (AUTHZ-06).
 */
