/**
 * Pipeline phase 10 — `verifySignature` (Phase S6, SIGN-01..10, AUTH-07).
 *
 * Verifies `SH-HMAC-SHA256` signatures on service-to-service (S2S) requests and,
 * on success, establishes a scoped service {@link Principal} for the downstream
 * `authorize` hook (SIGN-11). It runs at slot 10 — AFTER `authenticate` (slot 9),
 * which deliberately bypasses `sigv4Hmac` ops and defers principal establishment
 * to this phase. Browser/anonymous/cookie ops are handled at slot 9 and pass
 * straight through here.
 *
 * Web-standard only (ARCH-01): `crypto.subtle.verify`, `TextEncoder`, `URL`. No
 * `node:*`, no `Buffer`. All canonicalization is the SAME code the reference
 * signer uses (`./canonical.js`), so the verifier cannot drift from the signer.
 *
 * ## Verification flow (mirrors `plan/security/07-request-signing-hmac.md`)
 *
 *  1. Resolve the op; if no op or NOT an HMAC op → `next()` (slot 9 handled it).
 *  2. Require `config.stores.secrets`; absent → uniform 401, fail closed.
 *  3. Parse `Authorization` (SIGN-01) and `X-SH-Timestamp`; malformed → 401.
 *  4. SIGN-02 timestamp window: past-dated beyond `acceptanceWindowSeconds`, or
 *     future-dated beyond `maxForwardSkewSeconds` (asymmetric, SIGNING-02) → 401.
 *  5. SIGN-07 body hash: `readRawBody(c)` (BEFORE any `c.req.json()`), re-derive
 *     SHA-256, and if the client sent `X-SH-Body-Sha256` it MUST match — the
 *     client value is never trusted, only the re-derived one is signed.
 *  6. SIGN-05 key resolution: `secrets.getSigningKey(keyId)`; null (unknown /
 *     retired) → 401. The provider returns current + previous during rotation.
 *  7. SIGN-04 constant-time verify: rebuild the canonical string from the actual
 *     request and `crypto.subtle.verify('HMAC', key, sig, canonical)`; !ok → 401.
 *  8. SIGN-03 replay (OPT-OUT, RT-06): every non-`@readonly` signed op requires a
 *     `NonceStore` + `checkAndStore(signature, window)` by default; already-seen →
 *     401. `@readonly` ops skip it (opt in via `nonceForOps`); exempt a non-readonly
 *     op via `replaySafeOps`. No store wired → fail closed.
 *  9. Success: set the service `principal`, emit `auth.success` (LOG-10), `next()`.
 *
 * EVERY rejection emits a `sig.fail` audit event at-source (LOG-10) with a
 * `reason`, `principalRef: null`, `outcome: 'deny'` — this closes the `sig.fail`
 * event deferred from S9. The uniform 401 body is `{ code: 'Unauthorized' }`,
 * identical to `authenticate`, so a probe cannot tell which check failed.
 *
 * SIGN-12 hedge: canonicalization and the verify step sit behind small functions
 * in `./canonical.js`, so a SigV4-compatible variant could slot in behind the
 * same factory later without touching the core flow.
 */

import type { Context, MiddlewareHandler } from 'hono'
import type { SecurityConfig } from '../config.js'
import type { Principal } from '../storage/index.js'
import { buildAuditEvent, emitAudit, principalRef } from '../audit/audit.js'
import { readRawBody } from './rawBody.js'
import {
  asBufferSource,
  buildCanonicalString,
  fromHex,
  parseAuthorizationHeader,
  sha256Hex,
  BODY_SHA256_HEADER,
  TIMESTAMP_HEADER,
} from './canonical.js'

// ---------------------------------------------------------------------------
// Local types — declared here so core never imports generated code, mirroring
// the `authenticate`/`bodyGuards` convention.
// ---------------------------------------------------------------------------

/** The subset of an auth scheme this phase branches on. */
interface SigAuthScheme {
  type: 'oidc' | 'sigv4Hmac' | 'anonymous' | string
}

/** The slice of `OperationMeta` (registry.gen.ts) this phase reads. */
interface SignableOperation {
  authSchemes: SigAuthScheme[]
  /** Operation name — gates per-op nonce tracking (SIGN-03) and audit context. */
  name?: string
  /**
   * Whether the op is `@readonly` (registry-supplied). Drives opt-out replay
   * tracking (RT-06): non-readonly signed ops are nonce-tracked by default.
   * Absent ⇒ treated as non-readonly (the safe default — track it).
   */
  readonly?: boolean
}

/** Resolve a live request (method + concrete path) → operation metadata. */
type OpResolver = (method: string, path: string) => SignableOperation | undefined

/**
 * Maps a verified key ID (+ its claims) to a scoped service {@link Principal}
 * (SIGN-11: "a customer is just a `SecretProvider` key ID → scoped service
 * Principal"). The downstream `authorize` hook checks this principal's
 * `permissions`/`tenantId`.
 */
export type ServicePrincipalMapper = (
  keyId: string,
  claims?: Record<string, unknown>,
) => Principal

/**
 * Module-local config knobs for this phase, NOT on the base {@link SecurityConfig}
 * (which already carries `signing?: SigningConfig` and `stores.secrets`/`.nonce`).
 *
 * INTEGRATOR NOTE — naming to avoid a type collision: the base config's `signing`
 * is `SigningConfig` (`{ acceptanceWindowSeconds, nonceForOps }`). Rather than
 * widen/redeclare that object (forbidden — no edits to config.ts), the keyId →
 * Principal mapper lives on a SEPARATE top-level field `signingPrincipalMapper`.
 * So the two compose cleanly with no overlap:
 *   - `config.signing`               — policy (window, nonce ops)  [existing]
 *   - `config.signingPrincipalMapper`— the keyId → service Principal mapper [new]
 * Fold {@link SigningModuleConfig} into `PipelineConfig` via intersection exactly
 * like `ValidationConfig`/`CorsConfig`; nothing in here shadows an existing field.
 */
export interface SigningModuleConfig {
  /**
   * keyId → scoped service {@link Principal} (SIGN-11). Optional; defaults to a
   * minimal `{ id: keyId, permissions: [], claims: {}, kind: 'service' }`.
   */
  signingPrincipalMapper?: ServicePrincipalMapper
  /**
   * Maximum forward clock skew, in seconds, tolerated on the signing timestamp
   * (SIGNING-02). The acceptance window stays fully symmetric for PAST-dated
   * timestamps (clock skew in the slow direction), but a FUTURE-dated timestamp
   * is only accepted up to this small skew. Legitimate signers stamp ≈ now, so
   * the forward half of a symmetric `±window` is dead attack surface that widens
   * the post-nonce-expiry replay tail; clamping it removes that. Defaults to
   * {@link DEFAULT_MAX_FORWARD_SKEW_SECONDS}. Set to the acceptance window to
   * restore the old fully-symmetric behavior.
   */
  maxForwardSkewSeconds?: number
  /**
   * Server-side mandatory signed-header floor (SIGNING-04). Every name listed
   * here MUST appear in the client's `signedHeaders` or the request is rejected
   * with the uniform 401 — the client cannot opt OUT of binding these headers
   * into the signature. Compared case-insensitively. Defaults to
   * {@link DEFAULT_REQUIRED_SIGNED_HEADERS} (`['host']`), which binds the request
   * authority so a captured signature cannot be relayed to a different host that
   * trusts the same key. Set to `[]` to disable the floor.
   */
  requiredSignedHeaders?: string[]
  /**
   * Opt IN to serving a non-`@readonly` signed op WITHOUT a `NonceStore`
   * (SIGNING-03). By default such a configuration fails closed: a state-changing
   * S2S op with no replay defense is rejected rather than silently replayable.
   * Set this to `true` to accept the (replayable) tradeoff and fall back to the
   * warn-once-and-proceed behavior. Explicitly opting out of replay defense must
   * be a deliberate integrator choice, not the silent consequence of an omitted
   * store. Default `false` (fail closed).
   */
  allowReplayWithoutNonceStore?: boolean
}

/** The full config this phase reads. */
export type VerifySignatureConfig = SecurityConfig & SigningModuleConfig

// ---------------------------------------------------------------------------
// Defaults & helpers.
// ---------------------------------------------------------------------------

/** Default acceptance window when `config.signing` is present but unset (SIGN-02). */
const DEFAULT_ACCEPTANCE_WINDOW_SECONDS = 300

/**
 * Default forward clock-skew clamp (SIGNING-02). Future-dated timestamps are only
 * accepted up to this small skew, while past-dated ones keep the full window. A
 * legitimate signer stamps ≈ now, so a few seconds absorbs real clock drift.
 */
const DEFAULT_MAX_FORWARD_SKEW_SECONDS = 30

/**
 * Default mandatory signed-header floor (SIGNING-04): `host` binds the request
 * authority into the signature so a captured signature cannot be relayed to a
 * different host trusting the same key.
 */
const DEFAULT_REQUIRED_SIGNED_HEADERS = ['host'] as const

/**
 * Default keyId → service Principal: a minimal scoped service identity with no
 * permissions. An app supplies `signingPrincipalMapper` to grant scopes/tenant.
 */
const defaultServicePrincipal: ServicePrincipalMapper = (keyId) => ({
  id: keyId,
  permissions: [],
  claims: {},
  kind: 'service',
})

/** The single uniform 401 (matches `authenticate`): same status + body always. */
function uniform401(c: Context): Response {
  return c.json({ code: 'Unauthorized' }, 401)
}

/** All `sig.fail` rejection reasons (LOG-10 audit detail; never leaked to the client). */
type SigFailReason =
  | 'no_secret_backend'
  | 'malformed_auth'
  | 'missing_required_header'
  | 'bad_timestamp'
  | 'stale_timestamp'
  | 'body_hash_mismatch'
  | 'unknown_key'
  | 'bad_signature'
  | 'replay'

/**
 * Emit a `sig.fail` audit event at-source (LOG-10), then return the uniform 401.
 * `principalRef` is null — no identity was established. The `reason` is captured
 * for the trail but the 401 body never reveals it. Best-effort: `emitAudit` never
 * throws into the request path. Centralized so the shape can't drift between the
 * many rejection branches (mirrors `authenticate`'s `denyAuth`).
 */
async function denySig(
  config: SecurityConfig,
  c: Context,
  op: SignableOperation | undefined,
  reason: SigFailReason,
): Promise<Response> {
  await emitAudit(
    config.audit,
    buildAuditEvent({
      type: 'sig.fail',
      requestId: (c.get('requestId') as string | undefined) ?? '',
      principalRef: null,
      operation: op?.name,
      outcome: 'deny',
      detail: { reason },
    }),
    config.logger,
  )
  return uniform401(c)
}

/** True iff the op declares the `sigv4Hmac` S2S scheme. */
function usesHmac(op: SignableOperation): boolean {
  return op.authSchemes.some((s) => s.type === 'sigv4Hmac')
}

// ---------------------------------------------------------------------------
// verifySignature — the phase factory.
// ---------------------------------------------------------------------------

/**
 * Build the HMAC signature-verification middleware (pipeline phase 10).
 *
 * @param config  the injected {@link SecurityConfig} plus this module's
 *                {@link SigningModuleConfig} knobs. Reads `signing`
 *                (`acceptanceWindowSeconds`, `nonceForOps`), `stores.secrets`,
 *                `stores.nonce`, and the optional `signingPrincipalMapper`.
 * @param resolve `(method, path) → OperationMeta | undefined` from the registry.
 */
export function verifySignature(
  config: VerifySignatureConfig,
  resolve: OpResolver,
): MiddlewareHandler {
  const servicePrincipal = config.signingPrincipalMapper ?? defaultServicePrincipal
  // RT-06: op names already warned about a missing NonceStore, so the warning is
  // emitted at most once per op (not once per request).
  const warnedNoStoreOps = new Set<string>()

  const handler: MiddlewareHandler = async (c, next) => {
    const op = resolve(c.req.method, c.req.path)

    // 1. Non-HMAC ops (browser/anonymous/cookie) and unknown routes skip — slot 9
    //    handled them. Only `sigv4Hmac` ops are verified here.
    if (!op || !usesHmac(op)) {
      return next()
    }

    // 2. Fail closed: HMAC required but no secrets backend wired (SIGN-06).
    const secrets = config.stores.secrets
    if (!secrets) {
      return denySig(config, c, op, 'no_secret_backend')
    }

    // 3. Parse the Authorization header (SIGN-01) and the timestamp.
    const parsed = parseAuthorizationHeader(c.req.header('authorization'))
    if (!parsed) {
      return denySig(config, c, op, 'malformed_auth')
    }
    const tsRaw = c.req.header(TIMESTAMP_HEADER)
    if (tsRaw === undefined) {
      return denySig(config, c, op, 'bad_timestamp')
    }
    const ts = Number(tsRaw)
    if (!Number.isFinite(ts) || !Number.isInteger(ts)) {
      return denySig(config, c, op, 'bad_timestamp')
    }

    // SIGNING-04 — mandatory signed-header floor. The signed-header LIST is
    // attacker-chosen; without a server-side floor a client could omit `host`
    // (or another security-relevant header) from the signature. Require every
    // configured header to be present in the client's list, fail closed if not.
    const requiredSignedHeaders =
      config.requiredSignedHeaders ?? DEFAULT_REQUIRED_SIGNED_HEADERS
    const signedHeaderSet = new Set(parsed.signedHeaders)
    for (const required of requiredSignedHeaders) {
      if (!signedHeaderSet.has(required.toLowerCase())) {
        return denySig(config, c, op, 'missing_required_header')
      }
    }

    // 4. SIGN-02 — timestamp acceptance window (replay layer 1). Asymmetric
    //    (SIGNING-02): the past direction keeps the full window (tolerate a slow
    //    client clock), but the future direction is clamped to a small forward
    //    skew — a legitimate signer stamps ≈ now, so the forward half of a fully
    //    symmetric window is dead attack surface that widens the post-nonce-expiry
    //    replay tail. forwardSkew is clamped to the window so it can never widen it.
    const window = config.signing?.acceptanceWindowSeconds ?? DEFAULT_ACCEPTANCE_WINDOW_SECONDS
    const forwardSkew = Math.min(
      config.maxForwardSkewSeconds ?? DEFAULT_MAX_FORWARD_SKEW_SECONDS,
      window,
    )
    const now = Math.floor(Date.now() / 1000)
    if (now - ts > window || ts - now > forwardSkew) {
      return denySig(config, c, op, 'stale_timestamp')
    }

    // 5. SIGN-07 — re-derive the body hash from the ACTUAL received bytes. Read
    //    raw BEFORE anything calls c.req.json() (the ARCH-08 spike gotcha). Never
    //    trust the client-declared X-SH-Body-Sha256; if present it MUST match.
    const raw = await readRawBody(c)
    const bodyHash = await sha256Hex(raw)
    const declaredBodyHash = c.req.header(BODY_SHA256_HEADER)
    if (declaredBodyHash !== undefined && declaredBodyHash.toLowerCase() !== bodyHash) {
      return denySig(config, c, op, 'body_hash_mismatch')
    }

    // 6. SIGN-05 — resolve the key for this keyId (current OR previous in the
    //    rotation overlap). null ⇒ unknown / retired ⇒ reject.
    const key = await secrets.getSigningKey(parsed.keyId)
    if (!key) {
      return denySig(config, c, op, 'unknown_key')
    }

    // 7. SIGN-04 — rebuild the canonical string from the request and verify
    //    (crypto.subtle.verify is constant-time). The signed-header VALUES come
    //    from the live request; the LIST of which headers are signed comes from
    //    the Authorization header (authoritative).
    const signedHeaderPairs = parsed.signedHeaders.map<[string, string]>((name) => [
      name,
      c.req.header(name) ?? '',
    ])
    const url = new URL(c.req.url)
    const canonical = buildCanonicalString({
      method: c.req.method,
      path: url.pathname,
      query: url.search.startsWith('?') ? url.search.slice(1) : url.search,
      signedHeaders: signedHeaderPairs,
      bodySha256Hex: bodyHash,
      timestamp: ts,
    })

    const sigBytes = fromHex(parsed.signature)
    if (!sigBytes) {
      return denySig(config, c, op, 'malformed_auth')
    }
    const ok = await crypto.subtle.verify(
      'HMAC',
      key,
      asBufferSource(sigBytes),
      new TextEncoder().encode(canonical),
    )
    if (!ok) {
      return denySig(config, c, op, 'bad_signature')
    }

    // 8. SIGN-03 — replay layer 2, OPT-OUT by default (RT-06). Track the signature
    //    as the nonce within the acceptance window for every non-@readonly signed op
    //    (a state-changing S2S op must not be replayable even if never configured);
    //    a second sighting ⇒ replay ⇒ reject. @readonly ops are idempotent and skip
    //    tracking unless explicitly opted in via nonceForOps; a non-readonly op can
    //    be exempted via replaySafeOps when it is genuinely safe to replay.
    const replaySafe = config.signing?.replaySafeOps ?? []
    const nonceOptIn = config.signing?.nonceForOps ?? []
    const exempt = op.name !== undefined && replaySafe.includes(op.name)
    const forced = op.name !== undefined && nonceOptIn.includes(op.name)
    const needsNonce = (!op.readonly && !exempt) || forced
    if (needsNonce) {
      const nonceStore = config.stores.nonce
      if (!nonceStore) {
        // SIGNING-03 — fail closed by default. A non-readonly signed op with no
        // replay defense is a silently-replayable state-changing endpoint, so the
        // safe default on this misconfiguration is to deny (like the `forced`
        // opt-in branch always has). Running unprotected must be a deliberate
        // integrator choice: opt in via `allowReplayWithoutNonceStore`, which then
        // warns loudly (once) and proceeds.
        if (forced || !config.allowReplayWithoutNonceStore) {
          return denySig(config, c, op, 'replay')
        }
        const opKey = op.name ?? '<unknown>'
        if (!warnedNoStoreOps.has(opKey)) {
          warnedNoStoreOps.add(opKey)
          config.logger?.warn({
            event: 'signing.replay_unprotected',
            op: op.name,
            message:
              'Non-@readonly signed operation is served without a NonceStore (RT-06): ' +
              'replay tracking is OFF for it because allowReplayWithoutNonceStore is set. ' +
              'Wire stores.nonce to enable opt-out replay defense.',
          })
        }
      } else {
        // SIGNING-01 — store the nonce for 2*window. A timestamp is accepted for
        // up to `window + forwardSkew` of wall-clock time from any first sighting;
        // a 2*window TTL (>= window + forwardSkew, since forwardSkew <= window)
        // guarantees the nonce outlives every moment the same timestamp can still
        // pass the window check, closing the post-expiry replay gap.
        const fresh = await nonceStore.checkAndStore(parsed.signature, window * 2)
        if (!fresh) {
          return denySig(config, c, op, 'replay')
        }
      }
    }

    // 9. Success — establish the scoped service Principal (SIGN-11) and emit the
    //    at-source auth.success audit event (pseudonymized, mirrors authenticate).
    const principal = servicePrincipal(parsed.keyId)
    c.set('principal', principal)
    await emitAudit(
      config.audit,
      buildAuditEvent({
        type: 'auth.success',
        requestId: (c.get('requestId') as string | undefined) ?? '',
        principalRef: await principalRef(principal.id, config.auditSalt),
        operation: op.name,
        outcome: 'allow',
      }),
      config.logger,
    )

    await next()
    return
  }
  Object.defineProperty(handler, 'name', { value: 'verifySignature' })
  return handler
}
