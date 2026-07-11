import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import {
  requireResourcePolicy,
  isOwner,
  sameTenant,
  all,
  any,
  RESOURCE_CONTEXT_KEY,
  type ResourcePolicy,
  type RequireResourcePolicyOptions,
} from './resourcePolicy.js'
import type { Principal } from '../storage/index.js'

// ---------------------------------------------------------------------------
// Test harness — a tiny Hono app whose upstream middleware simulates S5 by
// setting `principal`, then mounts requireResourcePolicy, then a handler that
// reads the resource off context (proving the no-double-fetch reuse, AUTHZ-03).
// ---------------------------------------------------------------------------

function principal(over: Partial<Principal> = {}): Principal {
  return { id: 'user-1', permissions: [], claims: {}, kind: 'user', ...over }
}

interface MountResult {
  status: number
  body: unknown
  /** The resource value the handler observed on context (or undefined). */
  handlerSawResource: unknown
}

/**
 * Mount `requireResourcePolicy(policy, opts)` behind a principal-injecting
 * middleware and a terminal handler, fire one request, and report what happened.
 * `p === undefined` simulates auth never running.
 */
async function mount(
  policy: ResourcePolicy,
  opts: RequireResourcePolicyOptions,
  p: Principal | undefined,
): Promise<MountResult> {
  const app = new Hono()
  let handlerSawResource: unknown
  app.get(
    '/r/:id',
    async (c, next) => {
      if (p) c.set('principal' as never, p as never)
      await next()
    },
    requireResourcePolicy(policy, opts),
    (c) => {
      handlerSawResource = c.get((opts.resourceKey ?? RESOURCE_CONTEXT_KEY) as never)
      return c.json({ ok: true }, 200)
    },
  )
  const res = await app.request('/r/abc')
  const body = res.status === 200 || res.status === 404 || res.status === 403 || res.status === 401
    ? await res.json().catch(() => undefined)
    : undefined
  return { status: res.status, body, handlerSawResource }
}

// ---------------------------------------------------------------------------
// isOwner
// ---------------------------------------------------------------------------

describe('isOwner', () => {
  it('allows the owner, sets resource on context, and does NOT re-fetch (AUTHZ-03)', async () => {
    const resource = { ownerId: 'user-1', title: 'mine' }
    const load = vi.fn().mockResolvedValue(resource)
    const r = await mount(isOwner(), { load }, principal())
    expect(r.status).toBe(200)
    expect(r.handlerSawResource).toEqual(resource)
    // policy loaded it once; the handler reused it from context — single fetch.
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('denies a non-owner with 403 AccessDenied', async () => {
    const load = vi.fn().mockResolvedValue({ ownerId: 'someone-else' })
    const r = await mount(isOwner(), { load }, principal())
    expect(r.status).toBe(403)
    expect(r.body).toEqual({ code: 'AccessDenied' })
  })

  it('returns 404 NotFound when the resource is absent (load → null)', async () => {
    const load = vi.fn().mockResolvedValue(null)
    const r = await mount(isOwner(), { load }, principal())
    expect(r.status).toBe(404)
    expect(r.body).toEqual({ code: 'NotFound' })
  })

  it('honours a custom owner field', async () => {
    const load = vi.fn().mockResolvedValue({ createdBy: 'user-1' })
    const r = await mount(isOwner('createdBy'), { load }, principal())
    expect(r.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// sameTenant
// ---------------------------------------------------------------------------

describe('sameTenant', () => {
  it('allows when principal and resource share a tenant', async () => {
    const load = vi.fn().mockResolvedValue({ tenantId: 't1' })
    const r = await mount(sameTenant(), { load }, principal({ tenantId: 't1' }))
    expect(r.status).toBe(200)
  })

  it('denies a cross-tenant resource with 403 even with a valid principal (AUTHZ-07)', async () => {
    const load = vi.fn().mockResolvedValue({ tenantId: 't2' })
    const r = await mount(sameTenant(), { load }, principal({ tenantId: 't1' }))
    expect(r.status).toBe(403)
    expect(r.body).toEqual({ code: 'AccessDenied' })
  })

  it('denies an untenanted principal under the default deny mode', async () => {
    const load = vi.fn().mockResolvedValue({ tenantId: 't1' })
    const r = await mount(sameTenant(), { load }, principal()) // no tenantId
    expect(r.status).toBe(403)
  })

  it('allows an untenanted principal under allow mode (single-tenant)', async () => {
    const load = vi.fn().mockResolvedValue({ tenantId: 't1' })
    const r = await mount(
      sameTenant('tenantId', { onMissingTenant: 'allow' }),
      { load },
      principal(),
    )
    expect(r.status).toBe(200)
  })

  it('returns 404 when the resource is absent', async () => {
    const load = vi.fn().mockResolvedValue(null)
    const r = await mount(sameTenant(), { load }, principal({ tenantId: 't1' }))
    expect(r.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// all (AND)
// ---------------------------------------------------------------------------

describe('all (AND)', () => {
  it('allows when every policy allows', async () => {
    const load = vi.fn().mockResolvedValue({ ownerId: 'user-1', tenantId: 't1' })
    const r = await mount(all(sameTenant(), isOwner()), { load }, principal({ tenantId: 't1' }))
    expect(r.status).toBe(200)
    expect(r.handlerSawResource).toEqual({ ownerId: 'user-1', tenantId: 't1' })
  })

  it('denies with the failing policy reason and loads the resource ONCE across both (AUTHZ-03)', async () => {
    // sameTenant passes, isOwner denies (forbidden) — both share one memoized load.
    const load = vi.fn().mockResolvedValue({ ownerId: 'other', tenantId: 't1' })
    const r = await mount(all(sameTenant(), isOwner()), { load }, principal({ tenantId: 't1' }))
    expect(r.status).toBe(403)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('short-circuits a notFound to 404', async () => {
    const load = vi.fn().mockResolvedValue(null)
    const r = await mount(all(sameTenant(), isOwner()), { load }, principal({ tenantId: 't1' }))
    expect(r.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// any (OR)
// ---------------------------------------------------------------------------

describe('any (OR)', () => {
  it('allows when the first policy allows', async () => {
    const load = vi.fn().mockResolvedValue({ ownerId: 'user-1', tenantId: 'other' })
    // isOwner allows; sameTenant would deny — OR short-circuits on the allow.
    const r = await mount(any(isOwner(), sameTenant()), { load }, principal({ tenantId: 't1' }))
    expect(r.status).toBe(200)
  })

  it('denies (403) when all policies deny with a mix that saw the resource', async () => {
    const load = vi.fn().mockResolvedValue({ ownerId: 'other', tenantId: 'other' })
    const r = await mount(any(isOwner(), sameTenant()), { load }, principal({ tenantId: 't1' }))
    expect(r.status).toBe(403)
  })

  it('denies with 404 when every branch was notFound', async () => {
    const load = vi.fn().mockResolvedValue(null)
    const r = await mount(any(isOwner(), sameTenant()), { load }, principal({ tenantId: 't1' }))
    expect(r.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// 403 vs 404 mapping (AUTHZ-06) via a hand-rolled policy
// ---------------------------------------------------------------------------

describe('403-vs-404 mapping (AUTHZ-06)', () => {
  const notFoundPolicy: ResourcePolicy = {
    async check() {
      return { allow: false, reason: 'notFound' }
    },
  }
  const forbiddenPolicy: ResourcePolicy = {
    async check() {
      return { allow: false, reason: 'forbidden' }
    },
  }

  it('reason notFound → 404', async () => {
    const r = await mount(notFoundPolicy, {}, principal())
    expect(r.status).toBe(404)
    expect(r.body).toEqual({ code: 'NotFound' })
  })

  it('reason forbidden → 403', async () => {
    const r = await mount(forbiddenPolicy, {}, principal())
    expect(r.status).toBe(403)
    expect(r.body).toEqual({ code: 'AccessDenied' })
  })
})

// ---------------------------------------------------------------------------
// No principal → 401 (fail closed; auth should have run, AUTH-10)
// ---------------------------------------------------------------------------

describe('missing principal', () => {
  it('401s when no principal is on the context', async () => {
    const r = await mount(isOwner(), { load: vi.fn() }, undefined)
    expect(r.status).toBe(401)
    expect(r.body).toEqual({ code: 'Unauthorized' })
  })
})

// ---------------------------------------------------------------------------
// ReBAC seam — a stub ResourcePolicy delegating to a fake engine integrates
// with requireResourcePolicy with no core change (proves the adapter boundary).
// ---------------------------------------------------------------------------

describe('ReBAC adapter seam', () => {
  // A fake relationship engine: returns true iff a tuple exists.
  const fakeEngine = (tuples: Set<string>) => ({
    check: (req: { user: string; relation: string; object: string }) =>
      Promise.resolve(tuples.has(`${req.user}#${req.relation}#${req.object}`)),
  })

  function relationshipPolicy(
    engine: ReturnType<typeof fakeEngine>,
    relation: string,
  ): ResourcePolicy {
    return {
      async check(p, ctx) {
        const id = (ctx.input as { id?: string } | undefined)?.id ?? 'unknown'
        const ok = await engine.check({
          user: `user:${p.id}`,
          relation,
          object: `doc:${id}`,
        })
        return ok ? { allow: true } : { allow: false, reason: 'forbidden' }
      },
    }
  }

  it('allows when the engine reports the relationship exists', async () => {
    const engine = fakeEngine(new Set(['user:user-1#viewer#doc:abc']))
    const r = await mount(
      relationshipPolicy(engine, 'viewer'),
      { input: (c) => c.req.param() },
      principal(),
    )
    expect(r.status).toBe(200)
  })

  it('denies (403) when the engine reports no relationship', async () => {
    const engine = fakeEngine(new Set())
    const r = await mount(
      relationshipPolicy(engine, 'viewer'),
      { input: (c) => c.req.param() },
      principal(),
    )
    expect(r.status).toBe(403)
  })
})
