/**
 * Unit proof of the OAuth RS primitives (src/auth.ts): bearer resolution against a
 * fake verifier (valid / missing / verify-throws / malformed header), the per-op
 * scope + anonymity helpers, the exact `WWW-Authenticate` challenge strings, the RFC
 * 9728 PRM shape, and the claims→principal mapping. All web-standard, no node.
 */

import { describe, it, expect } from 'vitest'
import {
  protectedResourceMetadata,
  resolveBearer,
  challenge401,
  challenge403,
  requiredScopes,
  isAnonymous,
  principalFromClaims,
  type McpAuthConfig,
  type McpOperationMeta,
  type VerifiedTokenClaims,
  type BearerVerifier,
} from './index.js'
import { isBearerEligible, forbiddenScheme } from './auth.js'

const CLAIMS: VerifiedTokenClaims = {
  sub: 'user-1',
  iss: 'https://idp.example.com',
  aud: 'https://todo.example.com/mcp',
  exp: 9999999999,
  scopes: ['todos.read', 'todos.write'],
}

/** A fake verifier: returns CLAIMS for `good`, throws otherwise (bad sig/iss/aud/exp). */
const verifier: BearerVerifier = {
  async verify(token: string): Promise<VerifiedTokenClaims> {
    if (token === 'good') return CLAIMS
    throw new Error('invalid token')
  },
}

const cfg: McpAuthConfig = {
  resource: 'https://todo.example.com/mcp',
  authorizationServers: ['https://idp.example.com'],
  verifier,
}

const req = (auth?: string): Request =>
  new Request('https://todo.example.com/mcp', {
    method: 'POST',
    headers: auth ? { authorization: auth } : {},
  })

describe('resolveBearer', () => {
  it('returns claims for a valid Bearer token', async () => {
    const r = await resolveBearer(req('Bearer good'), cfg)
    expect(r).toEqual({ claims: CLAIMS })
  })

  it('is case-insensitive on the scheme', async () => {
    const r = await resolveBearer(req('bearer good'), cfg)
    expect('claims' in r).toBe(true)
  })

  it('returns unauthenticated when the header is missing', async () => {
    expect(await resolveBearer(req(), cfg)).toEqual({ unauthenticated: true })
  })

  it('returns unauthenticated when the verifier throws', async () => {
    expect(await resolveBearer(req('Bearer bad'), cfg)).toEqual({ unauthenticated: true })
  })

  it('returns unauthenticated for a malformed Authorization header', async () => {
    expect(await resolveBearer(req('Basic abc123'), cfg)).toEqual({ unauthenticated: true })
    expect(await resolveBearer(req('Bearer'), cfg)).toEqual({ unauthenticated: true })
  })
})

describe('requiredScopes', () => {
  const op: McpOperationMeta = {
    name: 'CreateTodo',
    method: 'POST',
    path: '/todos',
    requiredPermissions: ['todos.write'],
  }

  it('defaults to the op requiredPermissions (identity map)', () => {
    expect(requiredScopes(op, cfg)).toEqual(['todos.write'])
  })

  it('falls back to [] when there are no requiredPermissions', () => {
    expect(requiredScopes({ name: 'X', method: 'GET', path: '/x' }, cfg)).toEqual([])
  })

  it('honors a scopeFor override', () => {
    const override: McpAuthConfig = { ...cfg, scopeFor: () => ['custom.scope'] }
    expect(requiredScopes(op, override)).toEqual(['custom.scope'])
  })
})

describe('isAnonymous', () => {
  const op = (authSchemes?: { type: string }[]): McpOperationMeta => ({
    name: 'Op',
    method: 'GET',
    path: '/x',
    authSchemes,
  })

  it('is anonymous with no authSchemes', () => {
    expect(isAnonymous(op())).toBe(true)
    expect(isAnonymous(op([]))).toBe(true)
  })

  it('is anonymous when an `anonymous` scheme is listed', () => {
    expect(isAnonymous(op([{ type: 'oidc' }, { type: 'anonymous' }]))).toBe(true)
  })

  it('is NOT anonymous with only protected schemes', () => {
    expect(isAnonymous(op([{ type: 'oidc' }]))).toBe(false)
  })
})

describe('isBearerEligible (MCP-CORE-01)', () => {
  const op = (authSchemes?: { type: string }[]): McpOperationMeta => ({
    name: 'Op',
    method: 'POST',
    path: '/x',
    authSchemes,
  })

  it('is eligible for oidc-only and anonymous schemes', () => {
    expect(isBearerEligible(op([{ type: 'oidc' }]))).toBe(true)
    expect(isBearerEligible(op([{ type: 'anonymous' }]))).toBe(true)
    expect(isBearerEligible(op([{ type: 'oidc' }, { type: 'anonymous' }]))).toBe(true)
  })

  it('is eligible when there are no schemes at all', () => {
    expect(isBearerEligible(op())).toBe(true)
    expect(isBearerEligible(op([]))).toBe(true)
  })

  it('is NOT eligible for an HMAC-only (sigv4Hmac) op', () => {
    expect(isBearerEligible(op([{ type: 'sigv4Hmac' }]))).toBe(false)
  })

  it('is NOT eligible when ANY declared scheme is non-bearer (mixed oidc+hmac)', () => {
    expect(isBearerEligible(op([{ type: 'oidc' }, { type: 'sigv4Hmac' }]))).toBe(false)
  })
})

describe('forbiddenScheme (MCP-CORE-01)', () => {
  it('is a hard 403 with NO WWW-Authenticate challenge', async () => {
    const res = forbiddenScheme()
    expect(res.status).toBe(403)
    expect(res.headers.get('www-authenticate')).toBeNull()
    expect(await res.json()).toMatchObject({ error: 'access_denied' })
  })
})

describe('challenge401 / challenge403', () => {
  it('challenge401 carries the exact WWW-Authenticate string', () => {
    const res = challenge401(cfg, 'todos.write')
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://todo.example.com/.well-known/oauth-protected-resource", error="invalid_token", scope="todos.write"',
    )
  })

  it('challenge401 omits scope when none is given', () => {
    const res = challenge401(cfg)
    expect(res.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://todo.example.com/.well-known/oauth-protected-resource", error="invalid_token"',
    )
  })

  it('challenge403 carries insufficient_scope + scope', () => {
    const res = challenge403('todos.write')
    expect(res.status).toBe(403)
    expect(res.headers.get('www-authenticate')).toBe(
      'Bearer error="insufficient_scope", scope="todos.write"',
    )
  })

  it('challenge bodies report the error code', async () => {
    expect(await challenge401(cfg).json()).toEqual({ error: 'invalid_token' })
    expect(await challenge403('s').json()).toEqual({ error: 'insufficient_scope' })
  })
})

describe('protectedResourceMetadata', () => {
  it('returns the RFC 9728 JSON document', async () => {
    const res = protectedResourceMetadata(cfg)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({
      resource: 'https://todo.example.com/mcp',
      authorization_servers: ['https://idp.example.com'],
      bearer_methods_supported: ['header'],
    })
  })
})

describe('principalFromClaims', () => {
  it('maps claims → a user principal whose permissions are the scopes', () => {
    expect(principalFromClaims(CLAIMS)).toEqual({
      id: 'user-1',
      permissions: ['todos.read', 'todos.write'],
      claims: CLAIMS,
      kind: 'user',
    })
  })
})
