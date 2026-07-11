/**
 * `SH-HMAC-SHA256` canonicalization — the byte-exact signing contract (SIGN-01,
 * SIGN-12).
 *
 * This module is the single source of truth for how a request is reduced to the
 * exact bytes that get HMAC'd. **The signer and the verifier both import these
 * functions**, so they cannot diverge — canonicalization mismatches are *the*
 * classic signing bug, and the only defense is that there is exactly one
 * implementation of the rules. The published contract that mirrors this code is
 * `plan/security/07a-canonicalization-spec.md`; keep the two in lock-step.
 *
 * Web-standard only (ARCH-01): `crypto.subtle`, `TextEncoder`, `Uint8Array`. No
 * `node:*`, no `Buffer`.
 *
 * ## Canonical string layout (SIGN-01)
 *
 * Six fields, each terminated by a single `\n` (line feed, `0x0A`) — INCLUDING
 * the last. The string that is signed is exactly:
 *
 * ```
 * <METHOD>\n
 * <canonicalPath>\n
 * <canonicalQuery>\n
 * <canonicalSignedHeaders>\n
 * <bodySha256Hex>\n
 * <timestamp>\n
 * ```
 *
 * where each `<...>` is the normalized value defined below. The trailing `\n`
 * after the timestamp is part of the string (it makes the layout a clean
 * "every field is `<value>\n`" with no special-casing of the final line, which
 * removes a whole class of off-by-one bugs).
 *
 * ### Field normalization
 *
 *  1. **METHOD** — uppercased ASCII (`post` → `POST`).
 *  2. **canonicalPath** — the request path, used verbatim (already percent-decoded
 *     by the runtime's `URL`); empty path normalizes to `/`. No re-encoding,
 *     no trailing-slash munging — sign exactly the path the runtime routes on.
 *  3. **canonicalQuery** — the query parameters sorted by (key, then value), each
 *     key and value RFC3986-percent-encoded (see {@link encodeRfc3986}), rejoined
 *     `key=value` with `&`. Empty query → empty string. This makes the canonical
 *     query order-independent of how the client serialized it.
 *  4. **canonicalSignedHeaders** — for each signed header: name lowercased and
 *     trimmed, value trimmed and internal runs of whitespace collapsed to a single
 *     space; sorted by lowercased name; emitted as `name:value\n` (one per line,
 *     each terminated by `\n`). A header listed in `signedHeaders` but absent from
 *     the request contributes `name:\n` (empty value) — the list is authoritative.
 *  5. **bodySha256Hex** — lower-case hex SHA-256 of the EXACT received body bytes
 *     (SIGN-07). Empty body → SHA-256 of zero bytes
 *     (`e3b0c442...b855`). The client's declared `X-SH-Body-Sha256` is never
 *     trusted; the verifier re-derives this from {@link readRawBody}.
 *  6. **timestamp** — the signing time as **epoch seconds** (integer, decimal,
 *     no fraction). Epoch-seconds is chosen over RFC3339 deliberately: one
 *     unambiguous integer with no timezone/precision/format variance to get
 *     wrong. The verifier parses it back with `Number(...)`.
 *
 * The header block (field 4) is itself a list of `name:value\n` lines, so a
 * request with two signed headers `a` and `b` produces, for field 4, the bytes
 * `a:<va>\nb:<vb>\n`. Combined with the field's own terminating `\n` that means a
 * `\n\n` boundary follows the last header line — this is intentional and stable.
 */

/** The signing scheme identifier — the leading token of the `Authorization` value. */
export const SH_HMAC_SHA256 = 'SH-HMAC-SHA256' as const

/** `Authorization` header name. */
export const AUTHORIZATION_HEADER = 'authorization' as const
/** `X-SH-Timestamp` — the signing time, epoch seconds (see field 6 above). */
export const TIMESTAMP_HEADER = 'x-sh-timestamp' as const
/** `X-SH-Body-Sha256` — client-declared body hash; re-derived & compared (SIGN-07). */
export const BODY_SHA256_HEADER = 'x-sh-body-sha256' as const

// ---------------------------------------------------------------------------
// Hex (Web-standard; no Buffer).
// ---------------------------------------------------------------------------

/** Lower-case hex encoding of a byte buffer. */
export function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

/**
 * Decode a lower/upper-case hex string into a `Uint8Array`. Returns `null` on any
 * malformed input (odd length, non-hex char) so the verifier can treat a bad
 * `signature=` as a uniform 401 rather than throwing. Never throws.
 */
export function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    // parseInt tolerates a trailing junk char; guard against non-hex explicitly.
    if (Number.isNaN(byte) || !/^[0-9a-fA-F]{2}$/.test(hex.slice(i * 2, i * 2 + 2))) {
      return null
    }
    out[i] = byte
  }
  return out
}

/**
 * SHA-256 of raw bytes → lower-case hex (SIGN-07/09). Accepts an `ArrayBuffer`
 * (what {@link readRawBody} returns) or a `Uint8Array`. Uses `crypto.subtle.digest`
 * (ARCH-01).
 */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', asBufferSource(bytes))
  return toHex(new Uint8Array(digest))
}

/**
 * Normalize an `ArrayBuffer | Uint8Array` into a `BufferSource` whose backing is
 * an `ArrayBuffer` (not a `SharedArrayBuffer`), as the Web Crypto lib types
 * require. A `Uint8Array` view is passed through; a bare `ArrayBuffer` is used as
 * is. Copies only when the view is offset/length-bounded is unnecessary here —
 * `crypto.subtle` honors `byteOffset`/`byteLength`.
 */
export function asBufferSource(bytes: ArrayBuffer | Uint8Array): BufferSource {
  return bytes instanceof Uint8Array
    ? (bytes as unknown as Uint8Array<ArrayBuffer>)
    : bytes
}

// ---------------------------------------------------------------------------
// RFC3986 percent-encoding (query canonicalization, field 3).
// ---------------------------------------------------------------------------

/**
 * RFC3986 percent-encoding for query keys/values. `encodeURIComponent` leaves
 * `!'()*` and `~` un-encoded relative to RFC3986; we additionally encode
 * `!'()*` and pass `~` through (RFC3986 unreserved). The result is the strict
 * canonical form both signer and verifier produce, so a `+` vs `%20` or `*` vs
 * `%2A` discrepancy can never cause a mismatch.
 */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

// ---------------------------------------------------------------------------
// Canonical-string construction.
// ---------------------------------------------------------------------------

/** Collapse internal whitespace runs to a single space and trim the ends. */
function canonicalizeHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

/** Inputs to {@link buildCanonicalString}. */
export interface CanonicalParts {
  /** HTTP method (any case — uppercased internally). */
  method: string
  /** Request path, e.g. `/todos/123`. Empty → `/`. */
  path: string
  /** Raw query string WITHOUT the leading `?`, e.g. `b=2&a=1`. Empty → no query. */
  query: string
  /** The headers covered by the signature, as `[name, value]` pairs (any case). */
  signedHeaders: Array<[string, string]>
  /** Lower-case hex SHA-256 of the exact body bytes (SIGN-07). */
  bodySha256Hex: string
  /** Signing time, epoch seconds. */
  timestamp: number
}

/**
 * Canonicalize a raw query string (no leading `?`) to the field-3 form: params
 * split on `&`, each `key=value` split on the FIRST `=`, key+value
 * percent-decoded then RFC3986-re-encoded, sorted by (key, value), rejoined with
 * `&`. A param with no `=` is treated as `key=` (empty value). Empty input → `''`.
 */
export function canonicalQuery(query: string): string {
  if (query === '') return ''
  const pairs: Array<[string, string]> = []
  for (const part of query.split('&')) {
    if (part === '') continue
    const eq = part.indexOf('=')
    const rawKey = eq === -1 ? part : part.slice(0, eq)
    const rawValue = eq === -1 ? '' : part.slice(eq + 1)
    // Decode whatever the client sent, then re-encode canonically so `%2A` and
    // `*`, or `+` and `%20`, collapse to one form.
    pairs.push([
      encodeRfc3986(safeDecode(rawKey)),
      encodeRfc3986(safeDecode(rawValue)),
    ])
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  return pairs.map(([k, v]) => `${k}=${v}`).join('&')
}

/** `decodeURIComponent` that tolerates `+` (→ space) and never throws. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '))
  } catch {
    // Malformed %-escape — sign the literal bytes rather than throwing.
    return value
  }
}

/**
 * Build the canonical signed-headers block (field 4): each `[name, value]`
 * lowercased/trimmed/whitespace-collapsed, sorted by name, emitted as
 * `name:value\n`. The caller decides which headers are included (the signer's
 * `signedHeaders` list); a name with no value yields `name:\n`.
 */
export function canonicalHeaders(headers: Array<[string, string]>): string {
  const normalized = headers.map<[string, string]>(([name, value]) => [
    name.trim().toLowerCase(),
    canonicalizeHeaderValue(value),
  ])
  normalized.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return normalized.map(([name, value]) => `${name}:${value}\n`).join('')
}

/**
 * Assemble the full canonical string (SIGN-01). See the module JSDoc for the
 * exact layout and per-field normalization. Both {@link signRequest} and
 * {@link verifySignature} call this with the same inputs, which is what
 * guarantees a byte-exact match.
 */
export function buildCanonicalString(parts: CanonicalParts): string {
  const method = parts.method.toUpperCase()
  const path = parts.path === '' ? '/' : parts.path
  const query = canonicalQuery(parts.query)
  const headers = canonicalHeaders(parts.signedHeaders)
  // Each field terminated by \n, including the last (timestamp). The header
  // block already ends each line with \n, then field 4 adds its own boundary \n.
  return (
    `${method}\n` +
    `${path}\n` +
    `${query}\n` +
    `${headers}\n` +
    `${parts.bodySha256Hex}\n` +
    `${parts.timestamp}\n`
  )
}

// ---------------------------------------------------------------------------
// Authorization header parsing.
// ---------------------------------------------------------------------------

/** The three parameters carried by a parsed `Authorization` value. */
export interface ParsedAuthorization {
  keyId: string
  /** Lower-cased signed-header names, in the order the client listed them. */
  signedHeaders: string[]
  /** Lower-case hex signature. */
  signature: string
}

/**
 * Parse an `Authorization: SH-HMAC-SHA256 keyId=<id>, signedHeaders=<a;b>,
 * signature=<hex>` value. Returns `null` on ANY deviation (wrong scheme, missing
 * field, empty value) so the caller emits a uniform 401 — it never throws and
 * never partially accepts.
 *
 * Format rules:
 *  - leading token MUST be exactly `SH-HMAC-SHA256`, separated from the params by
 *    one or more spaces;
 *  - params are `name=value` pairs separated by `,` (optional surrounding spaces);
 *  - `signedHeaders` is a `;`-separated list, lowercased here;
 *  - all three of `keyId`, `signedHeaders`, `signature` MUST be present and
 *    non-empty.
 */
export function parseAuthorizationHeader(value: string | undefined): ParsedAuthorization | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  const sep = trimmed.indexOf(' ')
  if (sep === -1) return null
  const scheme = trimmed.slice(0, sep)
  if (scheme !== SH_HMAC_SHA256) return null

  const rest = trimmed.slice(sep + 1).trim()
  if (rest === '') return null

  const params = new Map<string, string>()
  for (const segment of rest.split(',')) {
    const eq = segment.indexOf('=')
    if (eq === -1) return null // a param with no `=` is malformed
    const key = segment.slice(0, eq).trim()
    const val = segment.slice(eq + 1).trim()
    if (key === '' || val === '') return null
    // Strict: reject a duplicate key rather than silently taking last-wins, so a
    // `keyId=a, ..., keyId=b` smuggling attempt is rejected (matches this
    // function's "null on ANY deviation" contract). (SIGNING-06)
    if (params.has(key)) return null
    params.set(key, val)
  }

  const keyId = params.get('keyId')
  const signedHeadersRaw = params.get('signedHeaders')
  const signature = params.get('signature')
  if (!keyId || !signedHeadersRaw || !signature) return null
  // Strict: exactly the three known params, no extras — the value is `null` on any
  // deviation, never partially accepted (SIGNING-06).
  if (params.size !== 3) return null

  const signedHeaders = signedHeadersRaw
    .split(';')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== '')
  if (signedHeaders.length === 0) return null
  // Reject a DUPLICATE signed-header name (e.g. `signedHeaders=host;host`): the
  // canonical rebuild would emit two `host:value\n` lines, so a duplicate is either
  // a signer bug or a smuggling attempt. Matches this function's "null on ANY
  // deviation" contract (SIGNING-06). NOTE on multi-VALUED request headers: the
  // Web `Headers` API merges repeated request headers into one `', '`-joined value
  // (there is no per-header getAll for arbitrary names), so a duplicated/injected
  // request header changes the canonical string and verification fails CLOSED with
  // `bad_signature` — never an auth bypass; this list-level check covers the part
  // the parser can see. (SIGNING-05)
  if (new Set(signedHeaders).size !== signedHeaders.length) return null

  // Normalize the signature to lower-case hex so that fromHex decoding,
  // crypto.subtle.verify, and the nonce-replay key all share ONE canonical
  // form. Without this, a case-flipped hex signature (e.g. `AB...` vs `ab...`)
  // decodes to identical bytes and verifies successfully, yet is a distinct
  // nonce key — defeating the SIGN-03 replay defense (the signer already emits
  // lower-case hex, so this is not a wire-format change). (SIGN-03)
  return { keyId, signedHeaders, signature: signature.toLowerCase() }
}

/**
 * Format the three parameters back into an `Authorization` value (the inverse of
 * {@link parseAuthorizationHeader}). Used by the signer; kept here so the wire
 * format lives in one place. `signedHeaders` is emitted lowercased and `;`-joined.
 */
export function formatAuthorizationHeader(parsed: ParsedAuthorization): string {
  const list = parsed.signedHeaders.map((h) => h.toLowerCase()).join(';')
  return `${SH_HMAC_SHA256} keyId=${parsed.keyId}, signedHeaders=${list}, signature=${parsed.signature}`
}
