import { describe, it, expect } from 'vitest'
import { MemorySessionStore } from '../storage/memory.js'
import type { Principal, SessionRecord, SessionStore } from '../storage/index.js'
import {
  issueSession,
  rotateSession,
  sessionFromOidcClaims,
  generateToken,
  timingSafeEqual,
  buildSessionCookie,
  clampIdleToAbsolute,
  DEFAULT_SESSION_COOKIE_NAME,
  type AuthConfig,
} from './session.js'
import type { VerifiedClaims } from './oidc.js'

/**
 * A {@link SessionStore} that records the TTL handed to `set`/`touch` so tests
 * can assert the exact backend TTL (RT-10 absolute-cap clamp) rather than only
 * the resulting lazy-eviction behavior.
 */
class TtlSpyStore implements SessionStore {
  private readonly inner = new MemorySessionStore()
  setTtls: number[] = []
  touchTtls: number[] = []

  async get(sessionId: string): Promise<SessionRecord | null> {
    return this.inner.get(sessionId)
  }
  async set(sessionId: string, rec: SessionRecord, ttlSeconds: number): Promise<void> {
    this.setTtls.push(ttlSeconds)
    return this.inner.set(sessionId, rec, ttlSeconds)
  }
  async delete(sessionId: string): Promise<void> {
    return this.inner.delete(sessionId)
  }
  async touch(sessionId: string, idleTtlSeconds: number): Promise<void> {
    this.touchTtls.push(idleTtlSeconds)
    return this.inner.touch(sessionId, idleTtlSeconds)
  }
}

const baseOpts: AuthConfig = {
  absoluteTtlSeconds: 3600,
  idleTtlSeconds: 900,
}

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    id: 'user-1',
    permissions: ['todos.read'],
    claims: { sub: 'user-1' },
    kind: 'user',
    ...overrides,
  }
}

/** Decode the base64url token length back to raw bytes. */
function tokenByteLength(token: string): number {
  const b64 = token.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64)
  return bin.length
}

describe('generateToken (AUTH-04 / CSRF-03)', () => {
  it('produces ≥128 bits of entropy', () => {
    const t = generateToken()
    expect(tokenByteLength(t) * 8).toBeGreaterThanOrEqual(128)
  })

  it('is URL/cookie-safe (base64url, no padding)', () => {
    const t = generateToken()
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('is unique across calls', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) seen.add(generateToken())
    expect(seen.size).toBe(100)
  })
})

describe('timingSafeEqual (AUTH-09)', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true)
  })
  it('returns false for differing equal-length strings', () => {
    expect(timingSafeEqual('abc123', 'abc124')).toBe(false)
  })
  it('returns false for different lengths', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
  })
  it('returns true for two empty strings', () => {
    expect(timingSafeEqual('', '')).toBe(true)
  })
  it('returns false when one side is empty and the other is not', () => {
    expect(timingSafeEqual('', 'x')).toBe(false)
    expect(timingSafeEqual('x', '')).toBe(false)
  })
  it('returns false regardless of how much longer the first operand is', () => {
    // AUTH-SESSION-03: the compare keys its loop on the second (secret) operand,
    // not max(len) — a far-longer first operand still yields a clean false.
    expect(timingSafeEqual('a'.repeat(1000), 'secret')).toBe(false)
    expect(timingSafeEqual('secret', 'a'.repeat(1000))).toBe(false)
  })
})

describe('buildSessionCookie (AUTH-03/06)', () => {
  it('sets HttpOnly, Secure, SameSite, Path=/ and no Domain', () => {
    const cookie = buildSessionCookie('__Host-session', 'abc', 'Lax')
    expect(cookie).toContain('__Host-session=abc')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
    expect(cookie).not.toContain('Domain')
  })
})

describe('issueSession (AUTH-04/05/06)', () => {
  it('mints a high-entropy id and CSRF token, persists, and returns a __Host- cookie', async () => {
    const store = new MemorySessionStore()
    const issued = await issueSession(store, principal(), baseOpts)

    expect(tokenByteLength(issued.sessionId) * 8).toBeGreaterThanOrEqual(128)
    expect(issued.csrfToken).toBeTruthy()
    expect(issued.sessionId).not.toBe(issued.csrfToken)

    // Cookie surface (AUTH-03/06).
    expect(issued.cookie.startsWith(`${DEFAULT_SESSION_COOKIE_NAME}=`)).toBe(true)
    expect(issued.cookie).toContain('HttpOnly')
    expect(issued.cookie).toContain('Secure')
    expect(issued.cookie).toContain('SameSite=Lax')
    expect(issued.cookie).toContain('Path=/')
    expect(issued.cookie).not.toContain('Domain')

    // Persisted with the right shape.
    const rec = await store.get(issued.sessionId)
    expect(rec).not.toBeNull()
    expect(rec!.principal.id).toBe('user-1')
    expect(rec!.csrfToken).toBe(issued.csrfToken)
    expect(rec!.absoluteExpiry).toBeGreaterThan(Date.now())
  })

  it('honors a custom cookie name and SameSite=Strict', async () => {
    const store = new MemorySessionStore()
    const issued = await issueSession(store, principal(), {
      ...baseOpts,
      cookieName: '__Host-sess2',
      sameSite: 'Strict',
    })
    expect(issued.cookie).toContain('__Host-sess2=')
    expect(issued.cookie).toContain('SameSite=Strict')
  })

  it('sets absoluteExpiry from absoluteTtlSeconds (AUTH-05 hard cap)', async () => {
    const store = new MemorySessionStore()
    const before = Date.now()
    const issued = await issueSession(store, principal(), {
      ...baseOpts,
      absoluteTtlSeconds: 100,
    })
    const cap = issued.record.absoluteExpiry
    expect(cap).toBeGreaterThanOrEqual(before + 100 * 1000)
    expect(cap).toBeLessThanOrEqual(Date.now() + 100 * 1000)
  })
})

describe('clampIdleToAbsolute (RT-10)', () => {
  it('returns the idle TTL when it fits under the absolute remainder', () => {
    const now = 1_000_000
    // absolute ceiling 1000s out, idle 100s → idle wins, untouched.
    expect(clampIdleToAbsolute(100, now + 1000 * 1000, now)).toBe(100)
  })

  it('clamps to the absolute remainder when idle exceeds it', () => {
    const now = 1_000_000
    // absolute ceiling 60s out, idle 900s → clamp to 60.
    expect(clampIdleToAbsolute(900, now + 60 * 1000, now)).toBe(60)
  })

  it('never returns a negative TTL (past the ceiling → 0)', () => {
    const now = 1_000_000
    expect(clampIdleToAbsolute(900, now - 5 * 1000, now)).toBe(0)
    expect(clampIdleToAbsolute(900, now, now)).toBe(0)
  })

  it('floors sub-second remainders down (seconds granularity)', () => {
    const now = 1_000_000
    // 500ms of absolute lifetime left → 0 whole seconds.
    expect(clampIdleToAbsolute(900, now + 500, now)).toBe(0)
  })
})

describe('issueSession backend TTL clamp (RT-10)', () => {
  it('passes the idle TTL unchanged when idle < remaining absolute lifetime', async () => {
    const store = new TtlSpyStore()
    // idle 900s, absolute 3600s → idle is the smaller; store TTL stays 900.
    await issueSession(store, principal(), baseOpts)
    expect(store.setTtls).toEqual([900])
  })

  it('clamps the backend TTL to the absolute remainder when idle > absolute', async () => {
    const store = new TtlSpyStore()
    // Misconfig: idle (900s) outlives the absolute ceiling (60s). The TTL handed
    // to the store must be the absolute remainder, NOT the idle TTL.
    await issueSession(store, principal(), {
      ...baseOpts,
      idleTtlSeconds: 900,
      absoluteTtlSeconds: 60,
    })
    expect(store.setTtls).toHaveLength(1)
    // Allow a 1s slack for the floor()'d now→absoluteExpiry computation.
    expect(store.setTtls[0]).toBeGreaterThanOrEqual(59)
    expect(store.setTtls[0]).toBeLessThanOrEqual(60)
    expect(store.setTtls[0]).toBeLessThan(900)
  })

  it('clamp is exercised through rotateSession too (re-issues)', async () => {
    const store = new TtlSpyStore()
    const first = await issueSession(store, principal(), {
      ...baseOpts,
      idleTtlSeconds: 900,
      absoluteTtlSeconds: 30,
    })
    await rotateSession(store, first.sessionId, principal(), {
      ...baseOpts,
      idleTtlSeconds: 900,
      absoluteTtlSeconds: 30,
    })
    // Both issuances clamped to the ~30s absolute remainder.
    expect(store.setTtls).toHaveLength(2)
    for (const ttl of store.setTtls) {
      expect(ttl).toBeGreaterThanOrEqual(29)
      expect(ttl).toBeLessThanOrEqual(30)
    }
  })
})

describe('rotateSession (AUTH-05 — privilege change)', () => {
  it('issues a new session and deletes the old one', async () => {
    const store = new MemorySessionStore()
    const first = await issueSession(store, principal(), baseOpts)
    const rotated = await rotateSession(store, first.sessionId, principal({ permissions: ['todos.write'] }), baseOpts)

    expect(rotated.sessionId).not.toBe(first.sessionId)
    // Old id is gone (fixation defense).
    expect(await store.get(first.sessionId)).toBeNull()
    // New id resolves with the elevated principal.
    const rec = await store.get(rotated.sessionId)
    expect(rec).not.toBeNull()
    expect(rec!.principal.permissions).toContain('todos.write')
  })
})

describe('sessionFromOidcClaims (AUTH-08 seam, RT-03 branded claims)', () => {
  const mapPermissions = (claims: Record<string, unknown>): string[] => {
    const scope = claims['scope']
    return typeof scope === 'string' ? scope.split(' ') : []
  }

  // RT-03: sessionFromOidcClaims now accepts ONLY the branded VerifiedClaims
  // produced by the oidc verifier. A raw object does not type-check (the brand
  // symbol is module-private). Tests stand in for the verifier output with a
  // narrow `as VerifiedClaims` cast — the ONE sanctioned place to do so.
  const verified = (claims: Record<string, unknown>): VerifiedClaims =>
    claims as unknown as VerifiedClaims

  it('maps validated claims → principal (id from sub, permissions via mapper)', async () => {
    const store = new MemorySessionStore()
    const issued = await sessionFromOidcClaims(
      store,
      verified({ sub: 'oidc-user-9', scope: 'todos.read todos.write', email: 'a@b.com' }),
      mapPermissions,
      baseOpts,
    )
    const rec = await store.get(issued.sessionId)
    expect(rec!.principal.id).toBe('oidc-user-9')
    expect(rec!.principal.permissions).toEqual(['todos.read', 'todos.write'])
    expect(rec!.principal.kind).toBe('user')
    expect(rec!.principal.claims['email']).toBe('a@b.com')
  })

  it('populates tenantId from the configured tenant claim (AUTHZ-07)', async () => {
    const store = new MemorySessionStore()
    const issued = await sessionFromOidcClaims(
      store,
      verified({ sub: 'u1', org: 'acme', scope: '' }),
      mapPermissions,
      { ...baseOpts, tenantClaim: 'org' },
    )
    const rec = await store.get(issued.sessionId)
    expect(rec!.principal.tenantId).toBe('acme')
  })

  it('throws when sub is missing', async () => {
    const store = new MemorySessionStore()
    await expect(
      sessionFromOidcClaims(store, verified({ scope: 'x' }), mapPermissions, baseOpts),
    ).rejects.toThrow()
  })

  it('leaves tenantId undefined for an EMPTY-STRING tenant claim (AUTHZ-07, finding routes-419)', async () => {
    // An empty-string tenant claim must NOT produce tenantId='' — the shared helper
    // (used by both the issue and rotate paths) requires a non-empty string.
    const store = new MemorySessionStore()
    const issued = await sessionFromOidcClaims(
      store,
      verified({ sub: 'u2', org: '', scope: '' }),
      mapPermissions,
      { ...baseOpts, tenantClaim: 'org' },
    )
    const rec = await store.get(issued.sessionId)
    expect(rec!.principal.tenantId).toBeUndefined()
  })

  it('TYPE GUARD (RT-03): a raw claims object is NOT assignable to VerifiedClaims', () => {
    // @ts-expect-error — a raw Record<string,unknown> lacks the private brand,
    // so it cannot be passed where VerifiedClaims is required. If this line ever
    // STOPS erroring, the compile-time auth-bypass guard has regressed.
    const _bad: VerifiedClaims = { sub: 'x', iss: 'y', aud: 'z', exp: 1, iat: 0 }
    expect(typeof _bad).toBe('object')
  })
})
