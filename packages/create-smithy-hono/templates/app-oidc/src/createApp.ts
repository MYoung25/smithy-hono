/**
 * The secure app factory — the single place all SEVEN security layers are composed
 * in front of the generated note router.
 *
 * `createApp(deps)`:
 *   1. builds the unified {@link PipelineConfig} + {@link AuthRoutesConfig} (config.ts),
 *   2. FAILS FAST via `validateConfig(OPERATIONS, config)` (OPS-06),
 *   3. mounts liveness/readiness probes BEFORE the pipeline (so an LB probe is not
 *      rejected by assertHttps / rate limiting),
 *   4. mounts the canonical 12-slot security pipeline (`createSecurityPipeline`),
 *   5. mounts the OIDC route helpers (login / callback / logout / csrf-token),
 *   6. mounts the generated note router with `requireResourcePolicy(isOwner())`
 *      wired into the GetNote / DeleteNote per-op slots, plus an `all`-slot
 *      middleware that binds the established principal for the domain layer.
 *
 * It is dependency-injected end to end: the deploy entry passes durable stores + a
 * real OIDC verifier; the e2e test passes in-memory stores + a fake local-JWKS
 * issuer. `basePath` prefixes every route (e.g. `/api` in production) so the API
 * sits same-origin under `/api/*` behind the static SPA.
 */

import { Hono } from 'hono'
import {
  createSecurityPipeline,
  validateConfig,
  healthHandler,
  readinessHandler,
  loginHandler,
  callbackHandler,
  logoutHandler,
  csrfTokenHandler,
  requireResourcePolicy,
  isOwner,
  withBasePath,
  type SecurityEnv,
  type Principal,
} from '@smithy-hono/security-core'
import { OPERATIONS } from './generated/registry.gen'
import { createNoteRouter } from './generated/notes.gen'
import { createNoteOps } from './implementation'
import type { NotesStore } from './notesStore'
import { buildPipelineConfig, buildAuthRoutesConfig, type SecureExampleDeps } from './config'
import { withPrincipal } from './requestContext'

export interface CreateAppDeps extends SecureExampleDeps {
  /** The domain note store (in-memory or otherwise). */
  notesStore: NotesStore
}

/** Prepend `prefix` to a route path; `''` leaves the root-mounted path unchanged. */
const at = (prefix: string, path: string) => `${prefix}${path}`

// The OIDC auth-helper routes are not model operations, but the pipeline must
// still know their auth posture so `authenticate` loads (or skips) the session for
// them: login/callback are pre-auth (anonymous), while /csrf-token and the
// state-changing /auth/logout are cookie-authed (so `authenticate` populates
// `c.get('session')` and the csrf phase guards logout). We register them as extra
// entries in the registry the pipeline reads — a superset of the generated ops.
const AUTH_HELPER_OPERATIONS: typeof OPERATIONS = {
  AuthLogin: { name: 'AuthLogin', method: 'GET', path: '/auth/login', authSchemes: [{ type: 'anonymous' }], readonly: true, requiredPermissions: [], cost: 1, constraints: { hasConstrainedInput: false } },
  AuthCallback: { name: 'AuthCallback', method: 'GET', path: '/auth/callback', authSchemes: [{ type: 'anonymous' }], readonly: true, requiredPermissions: [], cost: 1, constraints: { hasConstrainedInput: false } },
  AuthLogout: { name: 'AuthLogout', method: 'POST', path: '/auth/logout', authSchemes: [{ type: 'oidc' }], readonly: false, requiredPermissions: [], cost: 1, constraints: { hasConstrainedInput: false } },
  CsrfToken: { name: 'CsrfToken', method: 'GET', path: '/csrf-token', authSchemes: [{ type: 'oidc' }], readonly: true, requiredPermissions: [], cost: 1, constraints: { hasConstrainedInput: false } },
}

const PIPELINE_OPERATIONS: typeof OPERATIONS = { ...OPERATIONS, ...AUTH_HELPER_OPERATIONS }

export function createApp(deps: CreateAppDeps) {
  const pipelineConfig = buildPipelineConfig(deps)
  const authRoutesConfig = buildAuthRoutesConfig(deps, pipelineConfig)

  // Mount prefix (e.g. '/api'). The registry MUST be prefixed to match — see
  // `withBasePath`: the pipeline resolves each request's op from `c.req.path`
  // (the full path), so an unprefixed registry would fail to resolve `/api/...`
  // and the per-op auth/permission/CSRF checks would silently be skipped.
  const prefix = deps.basePath ?? ''
  const pipelineOps = withBasePath(PIPELINE_OPERATIONS, prefix)

  // (1) FAIL FAST at construction on an incoherent config (OPS-06): cookie ops
  // with no session store, signed ops with no secrets/nonce store, weak HSTS,
  // wildcard CORS, incomplete oidc block. Throws ConfigValidationError if fatal.
  validateConfig(pipelineOps, pipelineConfig)

  const app = new Hono<SecurityEnv>()

  // (2) Probes bypass the pipeline (registered first).
  app.get(at(prefix, '/healthz'), healthHandler())
  app.get(at(prefix, '/readyz'), readinessHandler(pipelineConfig))

  // (3) The canonical pre-deserialization security pipeline (ARCH-07): request-id,
  // logging, error-sanitizer, security-headers, assert-https, cors, body-guards,
  // rate-limit-per-ip, authenticate, verify-signature, csrf, rate-limit-per-principal.
  app.use('*', ...createSecurityPipeline(pipelineOps, pipelineConfig))

  // (4) OIDC browser-auth routes (RT-04). These are NOT in OPERATIONS, so the
  // pipeline runs only its generic guards for them (no per-op auth requirement),
  // EXCEPT the csrf phase, which still guards the cookie-authed POST /auth/logout.
  //   GET  /auth/login       → 302 to the IdP authorize endpoint (PKCE + state).
  //   GET  /auth/callback     → verify ID token (RT-03), mint+rotate session (RT-05),
  //                             set __Host-session cookie, return the CSRF token.
  //   POST /auth/logout       → revoke session + clear cookie (CSRF-guarded).
  //   GET  /csrf-token        → return the current session's CSRF token (needs auth).
  app.get(at(prefix, '/auth/login'), loginHandler(authRoutesConfig))
  app.get(at(prefix, '/auth/callback'), callbackHandler(authRoutesConfig))
  app.post(at(prefix, '/auth/logout'), logoutHandler(authRoutesConfig))
  app.get(at(prefix, '/csrf-token'), csrfTokenHandler())

  // (5) The generated note router. The resource-policy tier is not codegen'd
  // (AUTHZ-09): we drop `requireResourcePolicy(isOwner())` into the per-op slots
  // for the ops that act on a single owned resource. `load` fetches the note so
  // isOwner can compare `note.ownerId === principal.id`; a missing note → 404,
  // a not-owned note → 403 (AUTHZ-06).
  const ops = createNoteOps(deps.notesStore)
  // The generated router runs the per-op middleware slot (where this policy lives)
  // BEFORE its own zValidator('param'), so we read the path param directly off the
  // route match (`c.req.param('id')`) rather than the not-yet-populated valid('param').
  const ownerPolicy = (c: import('hono').Context) => deps.notesStore.get(c.req.param('id') ?? '')

  app.route(
    prefix || '/',
    createNoteRouter(ops, {
      // The `all` slot binds the pipeline-established principal for the domain
      // layer (the generated handler signature carries only validated input).
      all: [
        async (c, next) => {
          const principal = c.get('principal') as Principal | undefined
          if (principal) return withPrincipal(principal, () => next())
          return next()
        },
      ],
      GetNote: [
        requireResourcePolicy(isOwner(), {
          load: ownerPolicy,
          operation: OPERATIONS.GetNote,
        }),
      ],
      DeleteNote: [
        requireResourcePolicy(isOwner(), {
          load: ownerPolicy,
          operation: OPERATIONS.DeleteNote,
        }),
      ],
    }),
  )

  return { app, pipelineConfig, authRoutesConfig }
}
