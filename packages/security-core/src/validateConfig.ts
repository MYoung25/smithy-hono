/**
 * OPS-06 — fail-fast config validation.
 *
 * `SecurityConfig` is types-only: a misconfiguration (e.g. cookie-auth ops served
 * but `stores.session` unset, or signed ops with no `stores.secrets`) is otherwise
 * caught only at request time as a uniform 401 — invisible until traffic hits it.
 * {@link validateConfig} surfaces those incoherent combinations at CONSTRUCTION,
 * so an integrator calls it once at boot and fails fast (or logs warnings) instead
 * of shipping a silently-broken deployment.
 *
 * Web-standard only (ARCH-01): no `node:*`, no `Buffer`.
 */

import type { SecurityConfig } from './config.js'
import type { OperationRegistry } from './pipeline/index.js'

/** A single fail-fast violation. `fatal` errors throw; non-fatal are logged. */
export interface ConfigIssue {
  fatal: boolean
  code: string
  message: string
}

/** Thrown by {@link validateConfig} when one or more FATAL issues are found. */
export class ConfigValidationError extends Error {
  constructor(readonly issues: ConfigIssue[]) {
    super(
      'Invalid security config (OPS-06):\n' +
        issues.map((i) => `  - [${i.code}] ${i.message}`).join('\n'),
    )
    this.name = 'ConfigValidationError'
  }
}

/** Collect every config issue (fatal + warnings) without throwing. */
export function collectConfigIssues(
  registry: OperationRegistry,
  config: SecurityConfig,
): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  const ops = Object.values(registry)

  const hasScheme = (type: string) =>
    ops.some((op) => op.authSchemes.some((s) => s.type === type))
  const hasNonReadonlySigned = ops.some(
    (op) => !op.readonly && op.authSchemes.some((s) => s.type === 'sigv4Hmac'),
  )

  // Minimum length floor for high-entropy, per-deployment secrets (stateSecret,
  // auditSalt). A coarse proxy for entropy that cheaply rejects 'x'/'secret'.
  const MIN_SECRET_LENGTH = 32

  // True when `audience` carries no usable value: empty string, or an array with
  // no non-empty element. jose skips `aud` validation entirely for a falsy
  // audience, so an empty one silently accepts tokens minted for any relying party.
  const isEmptyAudience = (audience: string | string[]): boolean =>
    Array.isArray(audience)
      ? audience.every((a) => !a || a.trim() === '')
      : !audience || audience.trim() === ''

  // Cookie/OIDC auth needs a session store.
  if (hasScheme('oidc') && !config.stores.session) {
    issues.push({
      fatal: true,
      code: 'MISSING_SESSION_STORE',
      message: 'Operations use cookie/OIDC auth (authScheme "oidc") but stores.session is not set.',
    })
  }

  // S2S signing needs a secret backend.
  if (hasScheme('sigv4Hmac') && !config.stores.secrets) {
    issues.push({
      fatal: true,
      code: 'MISSING_SECRET_STORE',
      message: 'Operations are signed (authScheme "sigv4Hmac") but stores.secrets is not set.',
    })
  }

  // Non-readonly signed ops need a nonce store for replay defense (RT-06).
  if (hasNonReadonlySigned && !config.stores.nonce) {
    issues.push({
      fatal: true,
      code: 'MISSING_NONCE_STORE',
      message:
        'Non-@readonly signed operations are served but stores.nonce is not set — ' +
        'replay defense (RT-06) cannot run. Wire stores.nonce, mark the ops @readonly, ' +
        'or opt them out via signing.replaySafeOps.',
    })
  }

  // Signed-op timestamp window (SIGN-02) — the only replay defense for @readonly
  // signed ops. Reject 0/negative (rejects nearly all signed traffic) and an
  // absurdly large window (a ms-vs-s typo of 300000 widens it to ~3.5 days).
  const ACCEPTANCE_WINDOW_HARD_CAP_SECONDS = 3600 // 1h — above this is almost certainly a unit mistake.
  const ACCEPTANCE_WINDOW_SOFT_MAX_SECONDS = 900 // 15m — recommended ceiling.
  if (config.signing?.acceptanceWindowSeconds !== undefined) {
    const window = config.signing.acceptanceWindowSeconds
    if (!Number.isFinite(window) || !Number.isInteger(window) || window <= 0) {
      issues.push({
        fatal: true,
        code: 'INVALID_ACCEPTANCE_WINDOW',
        message: `signing.acceptanceWindowSeconds (${window}) must be a positive integer number of seconds.`,
      })
    } else if (window > ACCEPTANCE_WINDOW_HARD_CAP_SECONDS) {
      issues.push({
        fatal: true,
        code: 'INVALID_ACCEPTANCE_WINDOW',
        message:
          `signing.acceptanceWindowSeconds (${window}) exceeds the hard cap of ` +
          `${ACCEPTANCE_WINDOW_HARD_CAP_SECONDS}s — likely a milliseconds-vs-seconds mistake.`,
      })
    } else if (window > ACCEPTANCE_WINDOW_SOFT_MAX_SECONDS) {
      issues.push({
        fatal: false,
        code: 'WIDE_ACCEPTANCE_WINDOW',
        message:
          `signing.acceptanceWindowSeconds (${window}) is wider than the recommended ` +
          `${ACCEPTANCE_WINDOW_SOFT_MAX_SECONDS}s — captured signatures stay replayable for that long.`,
      })
    }
  }

  // OIDC login flow requires a complete oidc config.
  if (config.oidc) {
    if (!config.oidc.issuer || !config.oidc.clientId || !config.oidc.stateSecret) {
      issues.push({
        fatal: true,
        code: 'INCOMPLETE_OIDC',
        message: 'config.oidc is present but missing one of issuer/clientId/stateSecret.',
      })
    }
    // An empty audience makes jose skip `aud` validation, accepting ID tokens minted
    // by the same issuer for any other relying party (audience confusion). jose
    // short-circuits aud checks on a falsy/all-empty audience, so flag it fatally.
    if (isEmptyAudience(config.oidc.audience)) {
      issues.push({
        fatal: true,
        code: 'EMPTY_OIDC_AUDIENCE',
        message:
          'config.oidc.audience is empty — jose would skip aud validation, accepting ' +
          'ID tokens minted for any other relying party. Set the expected audience(s).',
      })
    }
    // stateSecret is the HMAC key for the __Host-oidc-tx cookie; a short key is
    // forgeable, weakening the login-CSRF/state-binding defense (OPS-06).
    if (config.oidc.stateSecret && config.oidc.stateSecret.length < MIN_SECRET_LENGTH) {
      issues.push({
        fatal: true,
        code: 'WEAK_STATE_SECRET',
        message:
          `config.oidc.stateSecret is too short (< ${MIN_SECRET_LENGTH} chars) — it signs the ` +
          '__Host-oidc-tx transaction cookie and must be a high-entropy, per-deployment secret.',
      })
    }
    // clockToleranceSeconds feeds jose's exp/iat skew allowance. `?? 60` is
    // nullish-only, so NaN/negative/huge values flow through unbounded — a
    // ms-vs-s typo (e.g. 60000 → ~16.7h) silently defeats token expiry, exactly
    // the class the sibling acceptanceWindow guard already protects against.
    const CLOCK_TOLERANCE_HARD_CAP_SECONDS = 300 // 5m — above this is almost certainly a unit mistake.
    if (config.oidc.clockToleranceSeconds !== undefined) {
      const tol = config.oidc.clockToleranceSeconds
      if (!Number.isFinite(tol) || !Number.isInteger(tol) || tol < 0) {
        issues.push({
          fatal: true,
          code: 'INVALID_CLOCK_TOLERANCE',
          message: `config.oidc.clockToleranceSeconds (${tol}) must be a non-negative integer number of seconds.`,
        })
      } else if (tol > CLOCK_TOLERANCE_HARD_CAP_SECONDS) {
        issues.push({
          fatal: true,
          code: 'INVALID_CLOCK_TOLERANCE',
          message:
            `config.oidc.clockToleranceSeconds (${tol}) exceeds the hard cap of ` +
            `${CLOCK_TOLERANCE_HARD_CAP_SECONDS}s — likely a milliseconds-vs-seconds mistake that would accept long-expired ID tokens.`,
        })
      }
    }
  }

  // HSTS must be a finite value of at least one year to be preload-eligible /
  // meaningful (HDR). A non-finite maxAge (NaN from `Number(env)`) slips past a
  // bare `<` comparison, so guard finiteness explicitly.
  if (!Number.isFinite(config.hsts.maxAge) || config.hsts.maxAge < 31_536_000) {
    issues.push({
      fatal: true,
      code: 'WEAK_HSTS',
      message: `hsts.maxAge (${config.hsts.maxAge}s) is not a finite value of at least one year (31536000s).`,
    })
  }

  // Session TTLs must be finite positive numbers — a NaN/0/negative value (e.g.
  // from `Number(env)`) silently corrupts the AUTH-05 absolute-expiry cap, yielding
  // sessions the store can never evict (NaN <= now is always false).
  if (!Number.isFinite(config.idleTtlSeconds) || config.idleTtlSeconds <= 0) {
    issues.push({
      fatal: true,
      code: 'INVALID_TTL',
      message: `idleTtlSeconds (${config.idleTtlSeconds}) must be a finite positive number of seconds.`,
    })
  }
  if (config.session) {
    const abs = config.session.absoluteTtlSeconds
    if (!Number.isFinite(abs) || abs <= 0) {
      issues.push({
        fatal: true,
        code: 'INVALID_TTL',
        message: `session.absoluteTtlSeconds (${abs}) must be a finite positive number of seconds.`,
      })
    } else if (Number.isFinite(config.idleTtlSeconds) && config.idleTtlSeconds > abs) {
      // The idle slide clamps to the absolute cap; idle exceeding it is incoherent.
      issues.push({
        fatal: true,
        code: 'INVALID_TTL',
        message:
          `idleTtlSeconds (${config.idleTtlSeconds}) exceeds session.absoluteTtlSeconds (${abs}) — ` +
          'the idle slide can never exceed the absolute cap.',
      })
    }
  }

  // Credentialed CORS must never use a wildcard origin (cookies are credentialed).
  if (config.allowedOrigins.includes('*')) {
    issues.push({
      fatal: true,
      code: 'WILDCARD_CORS_WITH_CREDENTIALS',
      message: 'allowedOrigins contains "*" — unsafe for a cookie/credentialed API. List exact origins.',
    })
  }

  // Each allowlisted origin must be a valid, bare absolute origin (scheme://host[:port]
  // with no path/query/trailing slash). The CORS middleware echoes a matched origin
  // verbatim together with `Access-Control-Allow-Credentials: true`, so a literal
  // `null` entry would credential a sandboxed-iframe/`data:`/`file:` `Origin: null`,
  // and a malformed/whitespaced entry silently never matches (CORS silently off).
  for (const origin of config.allowedOrigins) {
    if (origin === '*') continue // handled above
    const trimmed = origin.trim()
    if (trimmed !== origin) {
      issues.push({
        fatal: false,
        code: 'CORS_ORIGIN_WHITESPACE',
        message: `allowedOrigins entry "${origin}" has leading/trailing whitespace — it will never match a browser Origin; trim it.`,
      })
    }
    if (trimmed === 'null') {
      issues.push({
        fatal: true,
        code: 'INVALID_CORS_ORIGIN',
        message:
          'allowedOrigins contains the literal "null" — the browser sends `Origin: null` for ' +
          'sandboxed iframes / data: / file: contexts, which would be echoed credentialed. Remove it.',
      })
      continue
    }
    let url: URL | null = null
    try {
      url = new URL(trimmed)
    } catch {
      url = null
    }
    if (!url || trimmed !== `${url.protocol}//${url.host}`) {
      issues.push({
        fatal: true,
        code: 'INVALID_CORS_ORIGIN',
        message:
          `allowedOrigins entry "${origin}" is not a bare absolute origin (scheme://host[:port] with ` +
          'no path, query, or trailing slash). CORS matches the request Origin exactly, so a malformed entry never matches.',
      })
    }
  }

  // A keyed pseudonymizer salt should be set in production (RT-12). Warn by
  // default; a deployment that opts in with `requireAuditSalt: true` makes a
  // missing/empty salt a fatal boot error (fail-closed, RT-12).
  if (!config.auditSalt) {
    issues.push({
      fatal: config.requireAuditSalt === true,
      code: 'NO_AUDIT_SALT',
      message:
        'auditSalt is not set — principal pseudonymization falls back to an unsalted, ' +
        'correlatable hash (RT-12). Set a per-deployment salt in production' +
        (config.requireAuditSalt === true
          ? ' (required by requireAuditSalt).'
          : ', or set requireAuditSalt: true to make this fatal.'),
    })
  } else if (config.auditSalt.length < MIN_SECRET_LENGTH) {
    // Present-but-weak salt: a short HMAC key makes principal refs reversible over
    // a small id space / correlatable across deployments (LOG-11, RT-12).
    issues.push({
      fatal: true,
      code: 'WEAK_AUDIT_SALT',
      message:
        `auditSalt is too short (< ${MIN_SECRET_LENGTH} chars) — it keys principal-ref HMAC ` +
        'pseudonymization and must be a high-entropy, per-deployment secret.',
    })
  }

  // A limiter is only as good as its store: defaults configured but no store, or
  // vice versa, means throttling is silently off (RT-07) — warn only.
  const hasLimitDefaults = config.rateLimits !== undefined
  const hasLimitStore = config.stores.rateLimit !== undefined
  if (hasLimitDefaults !== hasLimitStore) {
    issues.push({
      fatal: false,
      code: 'LIMITER_DISABLED',
      message:
        'rateLimits defaults and stores.rateLimit must BOTH be set to throttle; ' +
        `only ${hasLimitDefaults ? 'rateLimits' : 'stores.rateLimit'} is set, so rate limiting is OFF.`,
    })
  }

  // Token-bucket specs feed MemoryRateLimitStore.consume directly: a 0/NaN/negative
  // capacity makes `tokens >= cost` false for every request (silent fail-CLOSED
  // outage), while a non-finite refill corrupts refill math. Surface incoherent
  // specs at boot (OPS-06 fail-fast) rather than as a silent runtime outage.
  if (config.rateLimits) {
    const RATE_LIMIT_SANE_CAP = 1_000_000 // implausibly-large ceiling — warn, don't fail.
    const checkSpec = (label: string, spec: { capacity: number; refillPerSecond: number } | undefined) => {
      if (!spec) return
      if (!Number.isFinite(spec.capacity) || spec.capacity <= 0) {
        issues.push({
          fatal: true,
          code: 'INVALID_RATE_LIMIT',
          message: `rateLimits.${label}.capacity (${spec.capacity}) must be a finite number greater than 0 — a non-positive capacity denies every request.`,
        })
      } else if (spec.capacity > RATE_LIMIT_SANE_CAP) {
        issues.push({
          fatal: false,
          code: 'WIDE_RATE_LIMIT',
          message: `rateLimits.${label}.capacity (${spec.capacity}) is implausibly large — the limiter is effectively off for that phase.`,
        })
      }
      if (!Number.isFinite(spec.refillPerSecond) || spec.refillPerSecond < 0) {
        issues.push({
          fatal: true,
          code: 'INVALID_RATE_LIMIT',
          message: `rateLimits.${label}.refillPerSecond (${spec.refillPerSecond}) must be a finite non-negative number of tokens per second.`,
        })
      }
    }
    checkSpec('perIp', config.rateLimits.perIp)
    checkSpec('perPrincipal', config.rateLimits.perPrincipal)
  }

  return issues
}

/**
 * Validate the security config against the operation registry (OPS-06). Throws a
 * {@link ConfigValidationError} on any FATAL issue; non-fatal issues are logged via
 * `config.logger?.warn`. Call once at construction/boot.
 *
 * @returns the non-fatal warnings (also logged), for the caller to inspect.
 */
export function validateConfig(
  registry: OperationRegistry,
  config: SecurityConfig,
): ConfigIssue[] {
  const issues = collectConfigIssues(registry, config)
  const fatal = issues.filter((i) => i.fatal)
  const warnings = issues.filter((i) => !i.fatal)

  for (const w of warnings) {
    config.logger?.warn({ event: 'config.warning', code: w.code, message: w.message })
  }
  if (fatal.length > 0) {
    throw new ConfigValidationError(fatal)
  }
  return warnings
}
