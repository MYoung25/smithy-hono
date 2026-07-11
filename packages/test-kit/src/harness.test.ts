import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import type { OperationRegistry, SecurityEnv } from '@smithy-hono/security-core'
import { createTestHarness, mountRouter, allPermissions, superuser } from './harness.js'
import { principal } from './builders.js'
import type { ClientOptionsLike, FetchLike } from './harness.js'

// ── A minimal "generated-like" service (registry + router + client factory) ─────

const OPERATIONS = {
  Ping: {
    name: 'Ping', method: 'GET', path: '/ping',
    authSchemes: [{ type: 'anonymous' }], readonly: true,
    requiredPermissions: [], cost: 1, constraints: { hasConstrainedInput: false },
  },
  Me: {
    name: 'Me', method: 'GET', path: '/me',
    authSchemes: [{ type: 'oidc' }], readonly: true,
    requiredPermissions: ['me.read'], cost: 1, constraints: { hasConstrainedInput: false },
  },
} satisfies OperationRegistry

function makeRouter() {
  const router = new Hono<SecurityEnv>()
  router.get('/ping', (c) => c.json({ ok: true }))
  router.get('/me', (c) => c.json({ id: c.get('principal')?.id ?? null }))
  return router
}

interface DemoClient {
  ping(): Promise<{ ok: boolean }>
  me(): Promise<{ id: string | null }>
}

const createDemoClient = (opts: ClientOptionsLike = {}): DemoClient => {
  const f: FetchLike = opts.fetch ?? (globalThis.fetch as FetchLike)
  const base = opts.baseUrl ?? ''
  return {
    async ping() { return (await f(`${base}/ping`)).json() as Promise<{ ok: boolean }> },
    async me() {
      const r = await f(`${base}/me`)
      if (!r.ok) throw new Error(`status ${r.status}`)
      return r.json() as Promise<{ id: string | null }>
    },
  }
}

function harness() {
  return createTestHarness({ operations: OPERATIONS, router: makeRouter(), createClient: createDemoClient })
}

// ── allPermissions / superuser ─────────────────────────────────────────────────

describe('permission helpers', () => {
  it('collects every required permission', () => {
    expect(allPermissions(OPERATIONS)).toEqual(['me.read'])
    expect(superuser(OPERATIONS).permissions).toEqual(['me.read'])
  })
})

// ── createTestHarness (full pipeline) ──────────────────────────────────────────

describe('createTestHarness', () => {
  it('anonymous route passes the pipeline (https injected by default)', async () => {
    const h = harness()
    expect(await h.client.ping()).toEqual({ ok: true })
  })

  it('protected route rejects without a session', async () => {
    const h = harness()
    await expect(h.client.me()).rejects.toThrow('status 401')
  })

  it('loginAs seeds a session and authenticates the client', async () => {
    const h = harness()
    const authed = await h.loginAs(principal({ id: 'u1', permissions: ['me.read'] }))
    expect(await authed.client.me()).toEqual({ id: 'u1' })
    // The session really landed in the store.
    expect(await h.stores.session.get(authed.sessionId)).not.toBeNull()
  })

  it('loginAs() with no args is a superuser that reaches protected routes', async () => {
    const h = harness()
    const authed = await h.loginAs()
    expect(authed.principal.permissions).toEqual(['me.read'])
    expect(await authed.client.me()).toEqual({ id: 'test-superuser' })
  })

  it('two loginAs() calls get DISTINCT default session ids (no aliasing onto one record)', async () => {
    const h = harness()
    const a = await h.loginAs(principal({ id: 'alice', permissions: ['me.read'] }))
    const b = await h.loginAs(principal({ id: 'bob', permissions: ['me.read'] }))
    // Distinct session ids → both records survive independently.
    expect(a.sessionId).not.toBe(b.sessionId)
    expect((await h.stores.session.get(a.sessionId))?.principal.id).toBe('alice')
    expect((await h.stores.session.get(b.sessionId))?.principal.id).toBe('bob')
    // Each client resolves to its OWN principal, not whichever was seeded last.
    expect(await a.client.me()).toEqual({ id: 'alice' })
    expect(await b.client.me()).toEqual({ id: 'bob' })
  })

  it('each harness gets fresh isolated stores', async () => {
    const a = harness()
    await a.loginAs()
    const b = harness()
    expect([...(await b.stores.session.get('test-session') ? [1] : [])]).toEqual([]) // b has no session
  })
})

// ── mountRouter (no pipeline) ──────────────────────────────────────────────────

describe('mountRouter', () => {
  it('defaults to a superuser principal when operations are provided', async () => {
    const { client } = mountRouter({ router: makeRouter(), createClient: createDemoClient, operations: OPERATIONS })
    expect(await client.me()).toEqual({ id: 'test-superuser' })
  })

  it('principal: null simulates an unauthenticated request', async () => {
    const { client } = mountRouter({ router: makeRouter(), createClient: createDemoClient, principal: null })
    expect(await client.me()).toEqual({ id: null })
  })

  it('uses a supplied principal', async () => {
    const { client } = mountRouter({
      router: makeRouter(),
      createClient: createDemoClient,
      principal: principal({ id: 'custom' }),
    })
    expect(await client.me()).toEqual({ id: 'custom' })
  })
})
