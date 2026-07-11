/**
 * OIDC ID-token verifier (Phase S5, AUTH-08/13, RT-03).
 *
 * Concrete ID-token validation for the cookie/OIDC browser flow: OIDC discovery
 * (issuer → `jwks_uri`), a cached remote JWKS, and signature + `iss` / `aud` /
 * `exp` / `iat` / `nonce` verification via {@link https://github.com/panva/jose
 * jose} (pure-JS, Web-Crypto — ARCH-01 allows it; no `node:*`, no `Buffer`).
 *
 * TREE-SHAKEABLE / OPTIONAL-IMPORT (RT-03): this is the ONLY module in core that
 * imports `jose`. It is never pulled in by an always-loaded barrel path — a
 * non-OIDC deploy that imports the pipeline / storage primitives never loads
 * `jose`. OIDC integrators import it explicitly (`@smithy-hono/security-core/auth/oidc`
 * or via the top-level barrel, whose `import` of this module is itself
 * tree-shakeable because the package is `sideEffects: false`).
 *
 * The verifier returns a BRANDED {@link VerifiedClaims} value: a claims bag
 * carrying a unique, non-constructible brand symbol. {@link
 * sessionFromOidcClaims} accepts ONLY this branded type, so a raw claims object
 * minted from anywhere but a real verification can no longer be passed where
 * verified claims are required (compile-time auth-bypass guard, RT-03).
 */

import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose'

// ---------------------------------------------------------------------------
// Branded verified-claims type (RT-03 compile-time guard).
// ---------------------------------------------------------------------------

/**
 * Unique brand carrier. The symbol is module-private (not exported), so no code
 * outside this module can synthesize a value bearing the `__verified` brand —
 * a plain `Record<string, unknown>` is therefore NOT assignable to
 * {@link VerifiedClaims}. This is the type-level half of the "verify before you
 * trust" guard; {@link assertVerifiedClaims} is the runtime half.
 */
declare const VERIFIED_BRAND: unique symbol

/**
 * OIDC ID-token claims that have passed full verification (signature + `iss` /
 * `aud` / `exp` / `iat` / `nonce`). Structurally a claims bag plus the standard
 * registered claims, tagged with a private brand so it cannot be forged by a
 * cast-free caller. Produced ONLY by {@link verifyIdToken} / an
 * {@link OidcVerifier}. Consumed by {@link sessionFromOidcClaims}.
 */
export type VerifiedClaims = Record<string, unknown> & {
  /** Subject — the stable user id (`sub`). Always present post-verification. */
  readonly sub: string
  /** Issuer (`iss`). */
  readonly iss: string
  /** Audience (`aud`) — string or array per the OIDC spec. */
  readonly aud: string | string[]
  /** Expiry, epoch seconds (`exp`). */
  readonly exp: number
  /** Issued-at, epoch seconds (`iat`). */
  readonly iat: number
  /** Nonce echoed from the authorize request (`nonce`), when present. */
  readonly nonce?: string
  /** The brand. Never constructible outside this module — see {@link VERIFIED_BRAND}. */
  readonly [VERIFIED_BRAND]: true
}

/**
 * Brand a freshly-verified payload as {@link VerifiedClaims}. Internal: the only
 * place the brand is applied, immediately after a successful jose verification.
 * The cast is sound because every caller has already validated the payload.
 */
function brand(payload: JWTPayload): VerifiedClaims {
  return payload as unknown as VerifiedClaims
}

/**
 * Runtime brand check (RT-03 runtime half). A genuine {@link VerifiedClaims}
 * always carries a string `sub`, a string `iss`, and a numeric `exp` — fields
 * the verifier guarantees. A raw object missing them fails here. This is a
 * defense-in-depth backstop for callers that reach the seam via an unsound cast
 * (e.g. `as VerifiedClaims`); the primary guard is the unforgeable brand type.
 *
 * Throws a {@link OidcVerificationError} when the value is not plausibly
 * verified claims.
 */
export function assertVerifiedClaims(value: unknown): asserts value is VerifiedClaims {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as Record<string, unknown>)['sub'] !== 'string' ||
    typeof (value as Record<string, unknown>)['iss'] !== 'string' ||
    typeof (value as Record<string, unknown>)['exp'] !== 'number'
  ) {
    throw new OidcVerificationError(
      'value is not verified OIDC claims (missing sub/iss/exp) — verify the ID token via verifyIdToken first',
    )
  }
}

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

/**
 * Thrown when ID-token verification fails for any reason (bad signature, wrong
 * `iss`/`aud`, expired, missing/mismatched `nonce`, malformed token, discovery
 * failure). One error type so a callback handler maps every failure to a uniform
 * `401` without leaking which check failed (AUTH-10 parity).
 */
export class OidcVerificationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'OidcVerificationError'
  }
}

/**
 * Thrown at verifier CONSTRUCTION time ({@link createOidcVerifier}) for an
 * incoherent {@link OidcConfig} — distinct from {@link OidcVerificationError}
 * (which is a per-token verify failure). This is a defense-in-depth backstop for
 * the standalone verifier path (e.g. `examples/secure-api`) that does not run the
 * boot-time `validateConfig` EMPTY_OIDC_AUDIENCE check.
 */
export class OidcConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OidcConfigError'
  }
}

/**
 * True when `audience` carries no usable value: empty string, or an array with no
 * non-empty element. jose skips `aud` validation entirely for a falsy audience,
 * so an empty one silently accepts tokens minted for any relying party. Mirrors
 * `validateConfig.ts`'s `isEmptyAudience` so the two guards agree.
 */
function isEmptyAudience(audience: string | string[]): boolean {
  return Array.isArray(audience)
    ? audience.every((a) => !a || a.trim() === '')
    : !audience || audience.trim() === ''
}

// ---------------------------------------------------------------------------
// Module-local config slice (the established pattern — see report for canonical
// SecurityConfig fields to add).
// ---------------------------------------------------------------------------

/**
 * OIDC verifier configuration. Module-local (not on `SecurityConfig`) per the
 * config-slice convention; the integrator folds the canonical fields
 * (`issuer`, `clientId`/`audience`, etc.) into `SecurityConfig` and constructs
 * this slice from them (see the integration report).
 */
export interface OidcConfig {
  /**
   * The IdP issuer URL (the `iss` claim and discovery base). Discovery fetches
   * `${issuer}/.well-known/openid-configuration` unless {@link jwksUri} is given.
   * Trailing slash is normalized.
   */
  issuer: string
  /**
   * Expected `aud` (the OIDC client id). The token's `aud` MUST contain this.
   * Accepts a single id or a set when the IdP issues multi-audience tokens.
   */
  audience: string | string[]
  /**
   * This relying party's own OIDC `client_id`, used for the `azp` (authorized
   * party) check (OIDC Core §3.1.3.7 steps 4/5). When `aud` is an array with
   * more than one entry the token MUST carry an `azp` equal to this; and whenever
   * `azp` is present at all it MUST equal this. Defaults to {@link audience} when
   * that is a single string (the common single-client deployment); when
   * `audience` is an array you SHOULD set this explicitly so the `azp` check has a
   * canonical client id to compare against.
   */
  clientId?: string
  /**
   * Explicit JWKS URI, bypassing discovery. Useful when the IdP's discovery
   * document is unavailable in-environment or for tests. When omitted, the
   * verifier discovers it from the issuer's well-known document.
   */
  jwksUri?: string
  /**
   * Clock skew tolerance, seconds, for `exp` / `iat` / `nbf` checks. Default
   * `60`. jose applies it symmetrically.
   */
  clockToleranceSeconds?: number
  /**
   * A pre-built JWKS key resolver (jose `createRemoteJWKSet` /
   * `createLocalJWKSet` result). Injected primarily for tests (a local JWKS) so
   * verification never hits the network; production passes nothing and the
   * verifier builds a cached remote set from discovery / {@link jwksUri}.
   */
  jwks?: JWTVerifyGetKey
}

/** Per-call verification inputs that vary request-to-request. */
export interface VerifyIdTokenOptions {
  /**
   * The expected `nonce` — the value the login initiator put in the authorize
   * request (carried in signed state / a cookie). When provided, the token's
   * `nonce` MUST match exactly or verification fails (OIDC replay defense). When
   * omitted, the `nonce` claim is not checked.
   *
   * SECURITY: a caller performing an OIDC authorization-code flow MUST supply
   * `nonce` (or set {@link requireNonce}) for replay defense — omitting it skips
   * the replay-binding check and accepts a captured/replayed ID token. The
   * bundled callback handler (`auth/routes.ts`) always passes `nonce`, so the
   * shipped login→callback flow is unaffected; this caveat applies only to direct
   * API consumers who call {@link verifyIdToken}/{@link OidcVerifier.verify}.
   */
  nonce?: string
  /**
   * Opt-in strict mode (additive, non-breaking): when `true`, verification THROWS
   * if {@link nonce} is not supplied, turning the "forgot to bind the nonce"
   * footgun into a hard failure. Default behavior (option omitted) is unchanged —
   * nonce is only checked when provided. Use this on direct code-flow callers that
   * want the replay-binding requirement enforced by the verifier.
   */
  requireNonce?: true
}

// ---------------------------------------------------------------------------
// Discovery + JWKS resolution (cached).
// ---------------------------------------------------------------------------

/** Strip a single trailing slash so `${issuer}/.well-known/...` is well-formed. */
function normalizeIssuer(issuer: string): string {
  return issuer.endsWith('/') ? issuer.slice(0, -1) : issuer
}

/** The slice of the OIDC discovery document we consume. */
interface DiscoveryDocument {
  issuer?: string
  jwks_uri?: string
}

/**
 * Fetch the issuer's discovery document and return its `jwks_uri`. Uses the
 * Web-standard `fetch` (ARCH-01). Throws {@link OidcVerificationError} on any
 * network / shape failure.
 */
async function discoverJwksUri(issuer: string): Promise<string> {
  const url = `${normalizeIssuer(issuer)}/.well-known/openid-configuration`
  let doc: DiscoveryDocument
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } })
    if (!res.ok) {
      throw new OidcVerificationError(`OIDC discovery failed: ${res.status} ${res.statusText}`)
    }
    doc = (await res.json()) as DiscoveryDocument
  } catch (cause) {
    if (cause instanceof OidcVerificationError) throw cause
    throw new OidcVerificationError('OIDC discovery request failed', { cause })
  }
  if (typeof doc.jwks_uri !== 'string' || doc.jwks_uri.length === 0) {
    throw new OidcVerificationError('OIDC discovery document missing jwks_uri')
  }
  return doc.jwks_uri
}

// ---------------------------------------------------------------------------
// OidcVerifier — factory holding the cached JWKS for an issuer.
// ---------------------------------------------------------------------------

/**
 * A reusable verifier for one issuer. Build it ONCE (per worker/instance) and
 * reuse it: `createRemoteJWKSet` keeps an in-process JWKS cache (with cooldown +
 * rotation handling), so a long-lived verifier avoids re-fetching keys on every
 * request. Each {@link OidcVerifier.verify} call validates one ID token.
 */
export interface OidcVerifier {
  /**
   * Verify one ID token. Resolves to {@link VerifiedClaims} on success;
   * rejects with {@link OidcVerificationError} on any failure (bad signature,
   * wrong `iss`/`aud`, expired/not-yet-valid, missing/mismatched `nonce`).
   */
  verify(idToken: string, options?: VerifyIdTokenOptions): Promise<VerifiedClaims>
}

/**
 * Build an {@link OidcVerifier} for an issuer. Resolves the JWKS source eagerly:
 *  - `config.jwks` injected (tests / custom)            → used as-is
 *  - else `config.jwksUri`                              → remote set on that URI
 *  - else discovery from `config.issuer`                → remote set on the
 *    discovered `jwks_uri`
 *
 * The returned verifier holds the cached key resolver, so construct it once and
 * reuse it across requests.
 */
export async function createOidcVerifier(config: OidcConfig): Promise<OidcVerifier> {
  // Defense-in-depth empty-audience guard (mirrors validateConfig's fatal
  // EMPTY_OIDC_AUDIENCE). The standalone verifier path bypasses validateConfig,
  // and jose skips `aud` validation for a falsy audience, so without this an ID
  // token minted by the same issuer for ANY other relying party would be accepted.
  if (isEmptyAudience(config.audience)) {
    throw new OidcConfigError(
      'OidcConfig.audience is empty — jose would skip aud validation, accepting ID tokens ' +
        'minted for any other relying party. Set the expected audience(s).',
    )
  }
  const issuer = normalizeIssuer(config.issuer)
  const clockTolerance = config.clockToleranceSeconds ?? 60
  // Canonical client id for the `azp` check (OIDC Core §3.1.3.7). Prefer an
  // explicit `clientId`; otherwise fall back to a single-string `audience` (the
  // common single-client deployment). When `audience` is an array and no
  // `clientId` was given there is no canonical client id, so the `azp` check is
  // best-effort (jose still enforces `clientId ∈ aud` via the `audience` option).
  const clientId =
    config.clientId ?? (typeof config.audience === 'string' ? config.audience : undefined)

  let getKey: JWTVerifyGetKey
  if (config.jwks) {
    getKey = config.jwks
  } else {
    const jwksUri = config.jwksUri ?? (await discoverJwksUri(issuer))
    getKey = createRemoteJWKSet(new URL(jwksUri))
  }

  return {
    async verify(idToken: string, options?: VerifyIdTokenOptions): Promise<VerifiedClaims> {
      let payload: JWTPayload
      try {
        const result = await jwtVerify(idToken, getKey, {
          issuer,
          audience: config.audience,
          clockTolerance,
          // jose enforces exp (and nbf/iat shape) here; requiredClaims forces iat
          // to be present (OIDC ID tokens MUST carry it).
          requiredClaims: ['iat'],
        })
        payload = result.payload
      } catch (cause) {
        throw new OidcVerificationError('ID token verification failed', { cause })
      }

      // `azp` (authorized party) binding (OIDC Core §3.1.3.7 steps 4/5). jose's
      // `audience` option is membership-only — a token whose `aud` merely
      // CONTAINS this client passes regardless of which client it was issued for,
      // so a token minted for another client (azp = attacker) is otherwise
      // accepted (token substitution / confused deputy). Enforce it explicitly:
      //   - if `aud` is an array with >1 entry, a string `azp` is REQUIRED and
      //     MUST equal this client id;
      //   - if `azp` is present at all (even single-element `aud`), it MUST equal
      //     this client id.
      if (clientId !== undefined) {
        const azp = payload['azp']
        const audIsMulti = Array.isArray(payload.aud) && payload.aud.length > 1
        if (audIsMulti && typeof azp !== 'string') {
          throw new OidcVerificationError('ID token missing azp for multi-audience aud')
        }
        if (azp !== undefined && azp !== clientId) {
          throw new OidcVerificationError('ID token azp mismatch')
        }
      }

      // Nonce binding (OIDC replay defense). jose does not check `nonce`, so we
      // do it explicitly against the expected value the login initiator stored.
      if (options?.nonce !== undefined) {
        if (typeof payload['nonce'] !== 'string' || payload['nonce'] !== options.nonce) {
          throw new OidcVerificationError('ID token nonce mismatch')
        }
      } else if (options?.requireNonce) {
        // Opt-in strict mode: a code-flow caller asked the verifier to enforce the
        // replay binding, but no expected nonce was supplied.
        throw new OidcVerificationError('nonce is required (requireNonce) but was not supplied')
      }

      // `sub` is mandatory for an OIDC ID token and required downstream.
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        throw new OidcVerificationError('ID token missing sub')
      }

      return brand(payload)
    },
  }
}

/**
 * One-shot ID-token verification (RT-03 acceptance helper). Convenience wrapper
 * that builds a verifier and verifies a single token. For request hot paths,
 * prefer {@link createOidcVerifier} once + reuse, so the JWKS cache survives
 * across requests rather than being discarded each call.
 */
export async function verifyIdToken(
  config: OidcConfig,
  idToken: string,
  options?: VerifyIdTokenOptions,
): Promise<VerifiedClaims> {
  const verifier = await createOidcVerifier(config)
  return verifier.verify(idToken, options)
}
