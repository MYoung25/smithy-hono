/**
 * todo-api MCP wiring — serve the generated operations as an OAuth 2.1-protected
 * MCP server (Plan 14 §11). This is the example half of the phase-2 auth slice; the
 * runtime (`@smithy-hono/mcp-core`) is the trust root, this file is the host glue.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TRUST BOUNDARY (read before touching the two-app assembly below).
 *
 * mcp-core is the SOLE OAuth resource server. On a protected `tools/call` it
 * verifies the bearer ONCE (signature + iss + exp + `aud` == `resource`, RFC 8707,
 * inside the injected `BearerVerifier`), checks the op's required scopes, derives a
 * `Principal` from the claims, and ONLY THEN dispatches into the app we hand it.
 * The raw token NEVER crosses into dispatch (no-passthrough rule, §11.2/§11.3) — the
 * inner app receives a derived `Principal`, attached by Request identity, and nothing
 * else. mcp-core itself produces the spec-mandated 401/403 + `WWW-Authenticate`.
 *
 * Why TWO apps:
 *   • OUTER (public) app — carries the real security pipeline (slots 1–8 still apply
 *     to `/mcp`, §11.4) PLUS the normal REST router, the `/mcp` mount, and the PRM
 *     route. On `/mcp` the pipeline's `authenticate`/`csrf`/`verifySignature` slots
 *     no-op (the path is not in OPERATIONS → `resolveOp` returns undefined), so
 *     bearer auth is mcp-core's job alone — exactly as §11.4 prescribes.
 *   • INNER (dispatch) app — the generated router with a tiny `principalInjector`
 *     `all`-slot middleware that reads the principal mcp-core attached to THIS
 *     synthetic Request (`getAttachedPrincipal`) and sets it on the Hono context.
 *     This BYPASSES the cookie `authenticate` slot (which only reads `__Host-`
 *     cookies and would 401 a bearer-only request), but the generated per-route
 *     `authorize(OPERATIONS.<Op>)` STILL runs and re-checks
 *     `requiredPermissions ⊆ principal.permissions` — defense in depth (§11.3).
 *     Anonymous `ListTodos` has no `authorize`, so it dispatches with no principal,
 *     exactly as an anonymous REST call would.
 *
 * The only code that can assert a principal for an MCP call is mcp-core, immediately
 * after a successful audience-checked verify — the trust boundary is one function wide.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import {
  createSecurityPipeline,
  MemorySessionStore,
  MemorySecretProvider,
  MemoryNonceStore,
  type PipelineConfig,
  type Principal,
  type SecurityEnv,
} from '@smithy-hono/security-core'
import {
  createMcpHandler,
  protectedResourceMetadata,
  getAttachedPrincipal,
  type BearerVerifier,
} from '@smithy-hono/mcp-core'
import { createTodoRouter, type TodoOperations } from '../generated/todo.gen'
import { OPERATIONS } from '../generated/registry.gen'
import { MCP_TOOLS } from '../generated/mcp.gen'

/**
 * Reads the principal mcp-core attached (by Request identity) to a synthetic MCP
 * dispatch Request and stamps it onto the Hono context, so the generated
 * `authorize` hook downstream sees an established identity WITHOUT the cookie
 * `authenticate` slot ever running. Anonymous calls carry no principal → no-op.
 */
const principalInjector: MiddlewareHandler<SecurityEnv> = async (c, next) => {
  const p = getAttachedPrincipal(c.req.raw)
  // `McpPrincipal` is structurally a security-core `Principal` (id/permissions/
  // claims/kind) — the cast just satisfies the typed context var.
  if (p) c.set('principal', p as Principal)
  await next()
}

export interface TodoMcpDeps {
  /** This RS's resource identifier — the canonical absolute `/mcp` URL. */
  resource: string
  /** AS issuer URL(s) advertised in PRM `authorization_servers`. */
  authorizationServers: string[]
  /**
   * The injected bearer verifier. Tests pass a fake (no network); production wraps
   * `createOidcVerifier` (see the production-wiring comment at the bottom of this file).
   */
  verifier: BearerVerifier
  /** Operations backing both the REST and the MCP surface. Defaults to `todoOps`. */
  ops: TodoOperations
  /**
   * Pipeline config for the OUTER app. Defaults to a security config whose transport
   * resolves to https (deterministic in-test — no `assertHttps` 400 over plain http).
   */
  securityConfig?: PipelineConfig
}

/**
 * A self-contained pipeline config that resolves transport to `https` so the e2e is
 * deterministic over in-memory http (mirrors the `forwardedProtoHeader` default the
 * security-e2e test uses). Production passes its real `securityConfig` via `deps`.
 */
function defaultSecurityConfig(): PipelineConfig {
  return {
    allowedOrigins: ['http://localhost:3000'],
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
    idleTtlSeconds: 900,
    // Resolve to https in-test so `assertHttps` passes deterministically. (Real
    // deployments inject a config whose proto resolver trusts a proxy header.)
    forwardedProtoHeader: (c) => c.req.header('x-forwarded-proto') ?? 'https',
    clientIp: () => 'mcp-inproc',
    maxBodyBytes: 1_048_576,
    protocolContentType: 'application/json',
    // Stores the pipeline reads even with no rate-limit/signing specs configured
    // (the limiter/signature slots are graceful no-ops without their specs). In-memory
    // here; production passes its real `securityConfig` (server.ts) via `deps`.
    stores: {
      session: new MemorySessionStore(),
      secrets: new MemorySecretProvider(),
      nonce: new MemoryNonceStore(),
    },
  }
}

/**
 * Assemble the OAuth-protected MCP host: an inner dispatch app (generated router +
 * `principalInjector`) wrapped by mcp-core, and an outer public app that carries the
 * security pipeline, the REST router, the `/mcp` mount, and the PRM route.
 *
 * Returns the outer app (drive it with `app.request(...)` in tests / `app.fetch` in
 * production) so callers get one Hono that serves BOTH the REST surface and `/mcp`.
 */
export function createTodoMcpApp(deps: TodoMcpDeps): Hono<SecurityEnv> {
  const { resource, authorizationServers, verifier, ops } = deps
  const securityConfig = deps.securityConfig ?? defaultSecurityConfig()

  const authCfg = { resource, authorizationServers, verifier }

  // INNER dispatch app — generated router + the principal injector on the `all` slot.
  // mcp-core dispatches here AFTER it has verified the bearer + derived the principal;
  // `authorize(OPERATIONS.<Op>)` re-checks scopes in-dispatch (defense in depth).
  const innerDispatchApp = createTodoRouter(ops, { all: [principalInjector] })

  const mcpHandler = createMcpHandler({
    tools: MCP_TOOLS,
    app: innerDispatchApp,
    info: { name: 'todo-api', version: '0.1.0' },
    auth: authCfg,
  })

  // OUTER public app — the real security pipeline in front of the REST router (the
  // cookie/HMAC schemes), PLUS the `/mcp` mount + PRM route. On `/mcp` the pipeline's
  // authenticate/csrf/verifySignature slots no-op (path not in OPERATIONS), so bearer
  // auth is mcp-core's alone (§11.4).
  const app = new Hono<SecurityEnv>()
  app.use('*', ...createSecurityPipeline(OPERATIONS, securityConfig))
  app.route('/', createTodoRouter(ops))

  // RFC 9728 discovery — MUST be reachable unauthenticated.
  app.get('/.well-known/oauth-protected-resource', () => protectedResourceMetadata(authCfg))
  // The MCP endpoint — mcp-core is the resource server here (its own "slot 9").
  app.all('/mcp', (c) => mcpHandler(c.req.raw))

  return app
}

// ─────────────────────────────────────────────────────────────────────────────
// PRODUCTION WIRING (§11.6) — build the real `BearerVerifier` from security-core's
// audience-checked OIDC verifier (reuse the existing IdP as the MCP Authorization
// Server). The example app injects this; mcp-core stays dependency-light (no `jose`).
//
//   import { createOidcVerifier } from '@smithy-hono/security-core/auth/oidc'
//
//   const MCP_RESOURCE = 'https://todo.example.com/mcp'
//   const IDP_ISSUER   = process.env.OIDC_ISSUER!
//   // `audience: MCP_RESOURCE` gives RFC 8707 audience validation for free — a token
//   // minted for any other audience is rejected inside verify().
//   const oidc = await createOidcVerifier({ issuer: IDP_ISSUER, audience: MCP_RESOURCE })
//   const verifier: BearerVerifier = {
//     async verify(token) {
//       const c = await oidc.verify(token)        // throws on bad sig/iss/aud/exp
//       // OAuth scopes ride the `scope` (space-delimited) or `scp` (array) claim.
//       const scopes = typeof c.scope === 'string' ? c.scope.split(' ')
//                    : Array.isArray(c.scp) ? (c.scp as string[]) : []
//       return { sub: c.sub, iss: c.iss, aud: c.aud, exp: c.exp, scopes, ...c }
//     },
//   }
//   const app = createTodoMcpApp({
//     resource: MCP_RESOURCE,
//     authorizationServers: [IDP_ISSUER],
//     verifier,
//     ops: todoOps,
//     securityConfig,                              // the real one exported from server.ts
//   })
// ─────────────────────────────────────────────────────────────────────────────
