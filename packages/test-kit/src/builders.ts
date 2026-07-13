import type { Context } from 'hono'
import type { Principal, SessionRecord, SecurityEnv } from '@smithy-hono/security-core'

export interface PrincipalOptions {
  permissions?: string[]
  id?: string
  kind?: 'user' | 'service'
  tenantId?: string
  claims?: Record<string, unknown>
}

/** A {@link Principal} with sensible test defaults — pass the permissions a route needs. */
export function principal(opts: PrincipalOptions = {}): Principal {
  const p: Principal = {
    id: opts.id ?? 'test-principal',
    permissions: opts.permissions ?? [],
    kind: opts.kind ?? 'user',
    claims: opts.claims ?? {},
  }
  if (opts.tenantId !== undefined) p.tenantId = opts.tenantId
  return p
}

/** Type guard: is the value a {@link Principal} (vs a plain options bag)? */
export function isPrincipal(value: unknown): value is Principal {
  return (
    typeof value === 'object' && value !== null &&
    'permissions' in value && Array.isArray((value as Principal).permissions) &&
    'kind' in value
  )
}

export interface SessionOptions {
  principal?: Principal
  csrfToken?: string
  /** Session id used as the cookie value. */
  sessionId?: string
  /** Absolute TTL in seconds (default 3600). */
  ttlSeconds?: number
}

/** A {@link SessionRecord} the auth helpers seed into the session store. */
export function sessionRecord(opts: SessionOptions = {}): SessionRecord {
  const now = Date.now()
  const p = opts.principal ?? principal()
  return {
    principal: p,
    createdAt: now,
    absoluteExpiry: now + (opts.ttlSeconds ?? 3600) * 1000,
    csrfToken: opts.csrfToken ?? 'test-csrf-token',
    claims: p.claims,
  }
}

/**
 * A minimal Hono {@link Context} for UNIT-testing an operation handler directly
 * (no HTTP): supports `c.get`/`c.set`/`c.var` over the {@link SecurityEnv} variables a
 * handler reads (`principal`, `session`, `resource`). Everything else is absent — use
 * the harness + generated client when a handler needs the real request/response.
 */
export function fakeContext(opts: { principal?: Principal; vars?: Record<string, unknown> } = {}): Context<SecurityEnv> {
  const store = new Map<string, unknown>(Object.entries(opts.vars ?? {}))
  if (opts.principal) store.set('principal', opts.principal)
  const ctx = {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => { store.set(key, value) },
    get var() { return Object.fromEntries(store) },
  }
  return ctx as unknown as Context<SecurityEnv>
}
