/**
 * OAuth 2.1 resource-server primitives for the MCP bridge (§11). All web-standard
 * (Request/Response/URL) — no `node:*`, no JWT library: token verification is the
 * injected {@link BearerVerifier}'s job (§11.6). This module owns the PRM document
 * (RFC 9728), the `WWW-Authenticate` challenge builders (RFC 6750/9728), and the
 * small per-op scope/anonymity helpers the `tools/call` gate reads.
 */

import type {
  McpAuthConfig,
  McpOperationMeta,
  McpPrincipal,
  VerifiedTokenClaims,
} from './types.js'

/** The well-known path a `WWW-Authenticate` challenge points discovery clients at. */
const PRM_PATH = '/.well-known/oauth-protected-resource'

/** Derive the absolute PRM URL from the RS `resource` identifier's origin. */
function prmUrl(cfg: McpAuthConfig): string {
  return new URL(PRM_PATH, cfg.resource).toString()
}

/**
 * The RFC 9728 Protected Resource Metadata document — a public discovery response
 * naming this RS and the authorization servers a client should obtain a token from.
 * `bearer_methods_supported` is `['header']`: we only accept the `Authorization`
 * header (no query/body token forms).
 */
export function protectedResourceMetadata(cfg: McpAuthConfig): Response {
  return Response.json({
    resource: cfg.resource,
    authorization_servers: cfg.authorizationServers,
    bearer_methods_supported: ['header'],
  })
}

/**
 * Resolve the bearer token on a request into verified claims. Parses
 * `Authorization: Bearer <t>` (case-insensitive scheme), then runs the injected,
 * audience-checked verifier. NEVER throws: a missing/malformed header OR a verifier
 * rejection both surface as `{ unauthenticated: true }` (the caller decides whether
 * that matters — public methods tolerate it, `tools/call` challenges).
 */
export async function resolveBearer(
  req: Request,
  cfg: McpAuthConfig,
): Promise<{ claims: VerifiedTokenClaims } | { unauthenticated: true }> {
  const header = req.headers.get('authorization')
  if (!header) return { unauthenticated: true }

  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim())
  if (!match) return { unauthenticated: true }

  try {
    const claims = await cfg.verifier.verify(match[1].trim())
    return { claims }
  } catch {
    // Bad signature / issuer / audience / expiry — all collapse to unauthenticated.
    return { unauthenticated: true }
  }
}

/**
 * A `401` challenge for a missing/invalid token (RFC 6750/9728): the
 * `WWW-Authenticate` header points the client at our PRM document so it can start
 * (or repair) its OAuth flow, and carries the required `scope` when known.
 */
export function challenge401(cfg: McpAuthConfig, scope?: string): Response {
  let value = `Bearer resource_metadata="${prmUrl(cfg)}", error="invalid_token"`
  if (scope) value += `, scope="${scope}"`
  return Response.json(
    { error: 'invalid_token' },
    { status: 401, headers: { 'www-authenticate': value } },
  )
}

/**
 * A `403` challenge for a valid token that lacks the required scope (RFC 6750):
 * `insufficient_scope` plus the scopes the op needs.
 */
export function challenge403(scope: string): Response {
  return Response.json(
    { error: 'insufficient_scope' },
    {
      status: 403,
      headers: { 'www-authenticate': `Bearer error="insufficient_scope", scope="${scope}"` },
    },
  )
}

/**
 * A hard `403` for an op whose auth scheme a bearer token can NOT satisfy (e.g. an
 * HMAC-only `@sigv4Hmac` S2S op). Unlike {@link challenge403} this is NOT an OAuth
 * `insufficient_scope` challenge — no scope a client could acquire would make the call
 * succeed — so it carries no `WWW-Authenticate` and signals a permanent refusal (MCP-CORE-01).
 */
export function forbiddenScheme(): Response {
  return Response.json(
    { error: 'access_denied', error_description: 'operation is not callable over MCP' },
    { status: 403 },
  )
}

/** The OAuth scopes an op requires: the configured map, else its `requiredPermissions`. */
export function requiredScopes(op: McpOperationMeta, cfg: McpAuthConfig): string[] {
  return cfg.scopeFor?.(op) ?? op.requiredPermissions ?? []
}

/**
 * True for an op that needs no principal: no auth schemes at all, or one that
 * explicitly lists `anonymous` (an `@optionalAuth` op like todo-api's `ListTodos`).
 */
export function isAnonymous(op: McpOperationMeta): boolean {
  return (
    !op.authSchemes ||
    op.authSchemes.length === 0 ||
    op.authSchemes.some((s) => s.type === 'anonymous')
  )
}

/** Schemes an MCP bearer token can stand in for: OAuth/OIDC (and anonymous). */
const BEARER_ELIGIBLE_SCHEMES = new Set(['oidc', 'anonymous'])

/**
 * Whether a verified OAuth bearer can legitimately satisfy this op's auth (§11.1).
 *
 * mcp-core never holds an HMAC shared secret, so it cannot produce the signature +
 * nonce an `@sigv4Hmac` (S2S) op requires; `verifySignature` does not run on the MCP
 * dispatch path either. Accepting a bearer for such an op would silently DOWNGRADE the
 * auth scheme — an OAuth token bearing the op's scope would invoke a signed,
 * replay-protected, service-only endpoint (MCP-CORE-01). So a bearer is eligible only
 * when EVERY declared scheme is bearer-satisfiable (oidc/anonymous); the presence of
 * any non-bearer scheme (e.g. `sigv4Hmac`) makes the op un-satisfiable over MCP.
 *
 * Anonymous ops never reach this check (they skip the gate), so an op with no schemes
 * is treated as bearer-eligible for completeness.
 */
export function isBearerEligible(op: McpOperationMeta): boolean {
  if (!op.authSchemes || op.authSchemes.length === 0) return true
  return op.authSchemes.every((s) => BEARER_ELIGIBLE_SCHEMES.has(s.type))
}

/**
 * Derive the principal the trusted dispatch carries from verified claims — the
 * exact shape `sessionFromOidcClaims` builds, but WITHOUT minting a session. The
 * granted scopes become the principal's permissions, which the generated
 * `authorize` hook then re-checks in-dispatch (defense in depth, §11.3).
 */
export function principalFromClaims(claims: VerifiedTokenClaims): McpPrincipal {
  return { id: claims.sub, permissions: claims.scopes, claims, kind: 'user' }
}
