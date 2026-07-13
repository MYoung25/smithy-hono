/**
 * Audit infrastructure (Phase S9, LOG-10/11/12).
 *
 * Separate from the request {@link Logger}: the audit trail is a typed, versioned
 * stream of security-relevant events emitted *at-source* (LOG-10) — the moment an
 * auth attempt, authz decision, signature check, or rate-limit trip resolves —
 * because that context cannot be reconstructed downstream. This module builds the
 * hard-to-retrofit seam now; the integrator wires concrete emission into the
 * limiter, `authenticate`, the signature verifier, and the authz hook afterward.
 *
 * Web-standard only (ARCH-01): pseudonymization and the hash chain use
 * `crypto.subtle` / `TextEncoder` — no `node:*`, no `Buffer`, no module-level env
 * reads (ARCH-05). The event/sink TYPES live on {@link AuditEvent} / {@link AuditSink}
 * in `../config.js` and are reused here, never redefined.
 *
 * Three concerns:
 *   - LOG-11 pseudonymization — {@link pseudonymize} / {@link createPseudonymizer}
 *     derive a stable, opaque `principalRef` from a raw principal id so raw PII
 *     never enters an event. The production form is a keyed HMAC (per-deployment
 *     secret): correlation-resistant across deployments, not reversible without the
 *     key — but NOT an absolute irreversibility guarantee for a tiny id space (see
 *     {@link pseudonymize}).
 *   - LOG-10 at-source emission — {@link buildAuditEvent} stamps a well-formed
 *     event; {@link emitAudit} delivers it best-effort (never throws into the
 *     request path).
 *   - LOG-12 tamper-evidence — {@link ChainedAuditSink} (default OFF) hash-chains
 *     events so a removed/altered record is detectable by re-walking the chain.
 */

import type { AuditEvent, AuditEventType, AuditSink, Logger } from '../config.js'
import { redactSensitive } from './redact.js'

// ---------------------------------------------------------------------------
// Hex helpers (Web-standard; no Buffer).
// ---------------------------------------------------------------------------

/** Lower-case hex encoding of a byte buffer. */
function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

/** SHA-256 of a UTF-8 string → lower-case hex (full 64-char digest). */
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return toHex(new Uint8Array(digest))
}

/**
 * HMAC-SHA-256 of `message` keyed by `key` (both UTF-8) → lower-case hex digest.
 * Keyed construction (vs. a bare salted digest): an attacker who does not hold the
 * key cannot precompute a rainbow table of `principalRef`s for a known id space,
 * because the key is mixed in by the MAC rather than merely prepended to the input.
 */
async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message))
  return toHex(new Uint8Array(sig))
}

// ---------------------------------------------------------------------------
// Pseudonymization (LOG-11).
// ---------------------------------------------------------------------------

/**
 * The number of hex chars kept from the digest for a `principalRef`. 16 hex chars
 * = 64 bits — collision-resistant enough to distinguish principals in a trail while
 * staying compact. (Truncation bounds collision risk; it does NOT by itself make a
 * ref irreversible — see {@link pseudonymize} for the reversibility caveat.)
 */
const PRINCIPAL_REF_HEX_LEN = 16

/**
 * The fixed, PUBLICLY-KNOWN key used by the dev/test fallback {@link defaultPseudonymize}.
 * It is intentionally a constant so the fallback is reproducible in tests — and is
 * therefore NOT a secret. A `principalRef` produced with it is correlatable and (for a
 * known/low-entropy id space) reversible by anyone, because the key is in the source.
 * Production MUST key the pseudonymizer with a real deployment secret via
 * {@link createPseudonymizer}.
 */
const INSECURE_DEV_PSEUDONYMIZE_KEY = 'security-core:INSECURE-DEV-PSEUDONYMIZE-KEY'

/**
 * A pluggable pseudonymization hook (LOG-11). Maps a raw principal id to a stable
 * reference. Injected by the app; build the production hook with
 * {@link createPseudonymizer} (keyed by a deployment secret).
 */
export type Pseudonymizer = (rawId: string) => Promise<string>

/**
 * Derive a STABLE `principalRef` from a raw principal id (LOG-11). When a `salt`/key
 * is supplied the ref is an HMAC-SHA-256 keyed by it; with no key it is a bare
 * SHA-256 of the id. The digest is truncated to {@link PRINCIPAL_REF_HEX_LEN} hex
 * chars. Same (id, key) → same ref (so a principal's events correlate within the
 * deployment); different ids → different refs; the raw id is never returned.
 *
 * Reversibility caveat (do not over-claim): the ref is NOT a guarantee of
 * irreversibility. For a small or low-entropy id space (emails, sequential ints)
 * anyone who can brute-force the id space offline can recover the id from a ref —
 * UNLESS the construction is keyed and they do not hold the key. So:
 *   - No key (bare hash): correlatable across any deployment AND reversible for a
 *     tiny id space by offline hashing. Suitable only for tests / throwaway dev.
 *   - Keyed (HMAC, secret key): correlation-resistant ACROSS deployments and not
 *     reversible by anyone WITHOUT the key. Still correlatable WITHIN the deployment
 *     by design (that is the point — a principal's events must link), and an
 *     attacker who learns the key regains both correlation and (for a tiny id space)
 *     reversibility. Use a high-entropy per-deployment secret and protect it.
 *
 * Async because `crypto.subtle` is async. Callers that need a `principalRef`
 * synchronously should derive it once up-front (e.g. when the principal is first
 * resolved in `authenticate`) and pass the precomputed ref through the context,
 * rather than re-deriving per log line.
 */
export async function pseudonymize(rawId: string, salt?: string): Promise<string> {
  const hex =
    salt === undefined
      ? await sha256Hex(rawId)
      : await hmacSha256Hex(salt, rawId)
  return hex.slice(0, PRINCIPAL_REF_HEX_LEN)
}

/**
 * Build a production {@link Pseudonymizer} keyed by a per-deployment `salt` secret
 * (LOG-11). The returned hook is HMAC-SHA-256 keyed by `salt`, so refs are stable
 * within this deployment but not correlatable across deployments and not reversible
 * by anyone who does not hold the secret (subject to the reversibility caveat on
 * {@link pseudonymize} for tiny id spaces). The `salt` is REQUIRED — there is no
 * unkeyed production default — and must be a high-entropy secret, distinct per
 * deployment, sourced from config (never hard-coded).
 *
 * @throws RangeError if `salt` is empty.
 */
export function createPseudonymizer(salt: string): Pseudonymizer {
  if (salt.length === 0) {
    throw new RangeError(
      'createPseudonymizer: a non-empty deployment salt/key is required (LOG-11)',
    )
  }
  return (rawId: string) => pseudonymize(rawId, salt)
}

/**
 * INSECURE dev/test fallback {@link Pseudonymizer}. Keyed by the PUBLIC constant
 * {@link INSECURE_DEV_PSEUDONYMIZE_KEY}, so its refs are reproducible in tests but
 * provide NO confidentiality: they are correlatable across deployments and reversible
 * for a known id space by anyone (the key is in the source). Production MUST replace
 * this with {@link createPseudonymizer}(<deployment secret>); see the wiring note in
 * the audit config. Exposed under this name because integrations expect a
 * `defaultPseudonymize` symbol to exist as the documented opt-out.
 */
export const defaultPseudonymize: Pseudonymizer = (rawId: string) =>
  pseudonymize(rawId, INSECURE_DEV_PSEUDONYMIZE_KEY)

/**
 * Derive a pseudonymized `principalRef` (LOG-11) — THE single implementation every
 * emission site shares (authenticate, rateLimit, verifySignature, and the request
 * logger) so the salt-presence rule cannot drift. A present, non-empty
 * `config.auditSalt` uses the keyed HMAC ({@link pseudonymize}); an absent OR
 * EMPTY-STRING salt routes through the NAMED insecure dev/test fallback
 * ({@link defaultPseudonymize}) — never a bare unsalted hash and never
 * `HMAC('', id)`. The empty-string case matters: `validateConfig` treats `''` as
 * "absent" (warn-only) so the app can boot with it, and if the four sites checked
 * salt-presence differently the request-log ref would diverge from the audit-event
 * refs for the same principal, breaking LOG-11 log↔audit correlation.
 */
export function principalRef(rawId: string, auditSalt: string | undefined): Promise<string> {
  return auditSalt !== undefined && auditSalt.length > 0
    ? pseudonymize(rawId, auditSalt)
    : defaultPseudonymize(rawId)
}

// ---------------------------------------------------------------------------
// Event construction (LOG-10).
// ---------------------------------------------------------------------------

/** Inputs to {@link buildAuditEvent} — the at-source caller supplies these. */
export interface AuditEventInput {
  type: AuditEventType
  requestId: string
  /** Pseudonymized principal reference, or `null` when there is no principal yet. */
  principalRef: string | null
  /** The operation name, when the event is tied to a modeled op. */
  operation?: string
  outcome: 'allow' | 'deny' | 'error'
  /** Sanitized, structured detail — never secrets/credentials/PII. */
  detail?: Record<string, unknown>
  /**
   * `@sensitive` dot-paths (e.g. `op.sensitiveFields`) to scrub from {@link detail}
   * before the event is built. The redaction seam is applied at this chokepoint so
   * any caller that places model-derived data in `detail` cannot bypass it (RT-13 /
   * LOG-03). Omit when `detail` carries only fixed, sensitive-field-free metadata.
   */
  sensitiveFields?: readonly string[]
}

/**
 * Stamp a well-formed {@link AuditEvent} from at-source `input`, setting `ts` to an
 * RFC3339 (ISO-8601) timestamp. Pure and synchronous so a middleware can build the
 * event inline the instant its decision is made (LOG-10), then hand it to
 * {@link emitAudit}.
 *
 * The timestamp uses `new Date(Date.now()).toISOString()`: `Date.now()` is always
 * available, whereas argless `new Date()` can be restricted in some hardened
 * sandboxes. No hash-chain fields are set here — `{ seq, prevHash, hash }` are
 * added only by {@link ChainedAuditSink}, when tamper-evidence is enabled (LOG-12).
 *
 * `input.detail` is passed through {@link redactSensitive} with `input.sensitiveFields`
 * so this is the single chokepoint that applies the `@sensitive` redaction seam: a
 * caller that places model-derived data in `detail` cannot emit an unredacted field.
 */
export function buildAuditEvent(input: AuditEventInput): AuditEvent {
  const event: AuditEvent = {
    type: input.type,
    ts: new Date(Date.now()).toISOString(),
    requestId: input.requestId,
    principalRef: input.principalRef,
    outcome: input.outcome,
  }
  if (input.operation !== undefined) event.operation = input.operation
  if (input.detail !== undefined) {
    // Apply the `@sensitive` redaction seam at the build chokepoint (RT-13 / LOG-03).
    // A no-op when there are no sensitive paths; never mutates the caller's object.
    event.detail = redactSensitive(input.detail, input.sensitiveFields)
  }
  return event
}

// ---------------------------------------------------------------------------
// Best-effort emission (LOG-10).
// ---------------------------------------------------------------------------

/**
 * Deliver `event` to `sink` best-effort. A no-op when `sink` is undefined (audit
 * disabled), and it NEVER throws into the request path — a sink failure must not
 * turn a successful request into a 500, nor mask the original outcome. A passed
 * `logger` surfaces the swallowed failure (operationally visible) without breaking
 * the request. When no `logger` is provided the failure still produces a diagnostic
 * via `console.error` (the same ambient surface the Node sinks use) so a dropped
 * audit record is never lost silently — a sink-but-no-logger deployment must not be
 * blind to its audit trail dropping events.
 */
export async function emitAudit(
  sink: AuditSink | undefined,
  event: AuditEvent,
  logger?: Logger,
): Promise<void> {
  if (!sink) return
  try {
    await sink.emit(event)
  } catch (err) {
    // Best-effort: never propagate. Surface via the logger when one was provided,
    // otherwise fall back to console.error so the drop is never silent.
    const record = {
      msg: 'audit sink emit failed',
      requestId: event.requestId,
      type: event.type,
      err: err instanceof Error ? err.message : String(err),
    }
    if (logger) logger.error(record)
    else console.error(record)
  }
}

// ---------------------------------------------------------------------------
// Hash-chain (LOG-12) — default OFF.
// ---------------------------------------------------------------------------

/**
 * Canonical JSON serialization of an event for hashing: keys sorted recursively so
 * the same logical event always yields the same bytes regardless of property
 * insertion order. The chain fields (`seq`/`prevHash`/`hash`) are excluded — they
 * are the OUTPUT of hashing, so hashing over them would be circular.
 */
export function canonical(event: AuditEvent): string {
  const { seq: _seq, prevHash: _prevHash, hash: _hash, ...rest } = event
  return canonicalStringify(rest)
}

/** Deterministic JSON.stringify with object keys sorted at every level. */
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const entries = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`,
  )
  return `{${entries.join(',')}}`
}

/** The genesis previous-hash for the first event in a chain (no predecessor). */
const GENESIS_PREV_HASH = ''

/**
 * Tamper-evident audit sink (LOG-12) — **opt-in / default OFF**. Wraps a real
 * delegate {@link AuditSink}; an app enables tamper-evidence only by constructing
 * `new ChainedAuditSink(realSink)` and injecting that as `config.audit`.
 *
 * Each emitted event is stamped with `{ seq, prevHash, hash }` where
 * `hash = SHA-256(prevHash + canonical(event))`, then the (copied, stamped) event
 * is delegated. The instance carries the running `seq`/`prevHash`; this mutable
 * state is intentional and safe because a single chain is, by design, a serial
 * append-only log — one chain, one writer. Concurrent independent chains each get
 * their own instance.
 *
 * Tamper-evidence, not tamper-PROOFING: an attacker who can rewrite the entire
 * stored stream can recompute every hash. The guarantee is *detectability* — any
 * event removed or altered after the fact breaks the link, found by re-walking the
 * stored events and recomputing each hash from its predecessor (see the tests).
 */
export class ChainedAuditSink implements AuditSink {
  #seq = 0
  #prevHash = GENESIS_PREV_HASH
  readonly #delegate: AuditSink
  /**
   * Serializes concurrent {@link emit} calls. The read-hash-advance sequence in
   * {@link #doEmit} spans an `await`, so two in-flight emits on the SAME shared
   * instance (a single `config.audit` sink is reused across requests) would
   * otherwise both read the same `seq`/`prevHash` before either advanced — forking
   * the chain (duplicate seq, gap, hash mismatch) and making ordinary concurrency
   * indistinguishable from tampering. Chaining each emit onto this tail makes the
   * read-hash-advance atomic per chain while preserving append order. (LOG-12)
   */
  #tail: Promise<void> = Promise.resolve()

  constructor(delegate: AuditSink) {
    this.#delegate = delegate
  }

  emit(event: AuditEvent): Promise<void> {
    // Serialize onto the tail so each emit's read-hash-advance runs to completion
    // before the next begins. The stored tail swallows rejections so one failed
    // emit does not permanently poison the chain for subsequent callers, but the
    // returned promise still rejects so this emit's caller sees the failure.
    const run = this.#tail.then(() => this.#doEmit(event))
    this.#tail = run.catch(() => {})
    return run
  }

  async #doEmit(event: AuditEvent): Promise<void> {
    const seq = this.#seq
    const prevHash = this.#prevHash
    const hash = await sha256Hex(prevHash + canonical(event))
    // Stamp a COPY so the caller's event object is not mutated.
    const chained: AuditEvent = { ...event, seq, prevHash, hash }
    // Delegate FIRST, advance the chain only once the write succeeds. If the
    // delegate throws (a dropped write), seq/prevHash stay put so the next event
    // links from the last SUCCESSFULLY persisted record — a re-walk stays
    // contiguous instead of showing a phantom gap that looks like tampering
    // (LOG-12). Emits are serialized on #tail, so no concurrent emit observes
    // the pre-advance state. A rare partial-write-then-throw is detectable as a
    // duplicate seq rather than masquerading as a silent deletion.
    await this.#delegate.emit(chained)
    this.#seq = seq + 1
    this.#prevHash = hash
  }
}
