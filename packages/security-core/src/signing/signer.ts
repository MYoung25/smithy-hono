/**
 * Reference `SH-HMAC-SHA256` signer (SIGN-12, SIGN v1 deliverable #3).
 *
 * A small, dependency-light, **portable** signer: it operates on plain inputs
 * (method/url/headers/body) with NO Hono dependency, so it runs unchanged in an
 * internal service, a browser SDK, or — critically — as the **test oracle** for
 * {@link verifySignature}. The verifier imports the SAME canonicalization from
 * `./canonical.js`, so "the signer signs it" and "the verifier verifies it" are
 * provably the same computation (see `roundtrip.test.ts`).
 *
 * Web-standard only (ARCH-01): `crypto.subtle.sign('HMAC', ...)`, `TextEncoder`,
 * `URL`. No `node:*`, no `Buffer`.
 *
 * The signing key is a {@link CryptoKey} imported with the `'sign'` usage (the
 * verifier imports the same secret with `'verify'`). {@link importHmacKey} is the
 * convenience wrapper around `crypto.subtle.importKey`.
 */

import {
  SH_HMAC_SHA256,
  asBufferSource,
  buildCanonicalString,
  formatAuthorizationHeader,
  sha256Hex,
  toHex,
  BODY_SHA256_HEADER,
  TIMESTAMP_HEADER,
  AUTHORIZATION_HEADER,
} from './canonical.js'

/** A request body in any of the forms a caller is likely to have it in. */
export type SignableBody = ArrayBuffer | Uint8Array | string | undefined

/** Inputs to {@link signRequest}. */
export interface SignRequestInput {
  /** HTTP method (any case). */
  method: string
  /** The full request URL — path and query are extracted via `URL`. */
  url: string
  /**
   * The full request header set as a plain object. Only the names listed in
   * `signedHeaders` are covered by the signature; the rest are ignored.
   */
  headers: Record<string, string>
  /** The request body (its SHA-256 is derived and signed, SIGN-07). */
  body?: SignableBody
  /** The key ID — echoed in the `Authorization` header for rotation lookup (SIGN-05). */
  keyId: string
  /** The HMAC signing key (imported with `'sign'` usage — see {@link importHmacKey}). */
  key: CryptoKey
  /** The header names to cover by the signature (lowercased internally). */
  signedHeaders: string[]
  /** Signing time, epoch seconds. The verifier enforces its acceptance window (SIGN-02). */
  timestamp: number
}

/** The output of {@link signRequest}: the auth value plus the headers to attach. */
export interface SignedRequest {
  /** The `Authorization` header value (`SH-HMAC-SHA256 keyId=..., ...`). */
  authorization: string
  /**
   * The complete set of headers the client must send for the signature to verify:
   * `Authorization`, `X-SH-Timestamp`, and `X-SH-Body-Sha256`. Header NAMES use the
   * canonical wire casing so they can be spread onto a request directly.
   */
  headers: Record<string, string>
  /** The canonical string that was signed — exposed for debugging/tests. */
  canonicalString: string
  /** The body hash that was signed (lower-case hex). */
  bodySha256: string
}

/** Normalize any {@link SignableBody} into bytes for hashing. */
function bodyBytes(body: SignableBody): ArrayBuffer | Uint8Array {
  if (body === undefined) return new Uint8Array(0)
  if (typeof body === 'string') return new TextEncoder().encode(body)
  return body
}

/**
 * Sign a request with `SH-HMAC-SHA256` (SIGN-01/07/09).
 *
 * Steps: derive the body SHA-256 (SIGN-07) → pull the `signedHeaders` values from
 * `headers` → build the canonical string via {@link buildCanonicalString} → HMAC
 * it with `crypto.subtle.sign('HMAC', key, ...)` → return the `Authorization`
 * value and the `X-SH-Timestamp` / `X-SH-Body-Sha256` headers to attach.
 *
 * Deterministic: a fixed `(key, timestamp, request)` always yields the same
 * `Authorization` — which is what makes the round-trip and the signer's own
 * stability test possible.
 */
export async function signRequest(input: SignRequestInput): Promise<SignedRequest> {
  const url = new URL(input.url)
  const bodySha256 = await sha256Hex(bodyBytes(input.body))

  // Lower-case the requested header names and pull their values from the set.
  const lowerHeaders = lowercaseKeys(input.headers)
  const signedHeaderPairs = input.signedHeaders.map<[string, string]>((name) => {
    const lname = name.trim().toLowerCase()
    return [lname, lowerHeaders[lname] ?? '']
  })

  const canonicalString = buildCanonicalString({
    method: input.method,
    path: url.pathname,
    query: url.search.startsWith('?') ? url.search.slice(1) : url.search,
    signedHeaders: signedHeaderPairs,
    bodySha256Hex: bodySha256,
    timestamp: input.timestamp,
  })

  const sigBytes = await crypto.subtle.sign(
    'HMAC',
    input.key,
    new TextEncoder().encode(canonicalString),
  )
  const signature = toHex(new Uint8Array(sigBytes))

  const authorization = formatAuthorizationHeader({
    keyId: input.keyId,
    signedHeaders: input.signedHeaders.map((h) => h.trim().toLowerCase()),
    signature,
  })

  return {
    authorization,
    headers: {
      // Wire-casing header names so the object spreads onto a fetch/request.
      Authorization: authorization,
      'X-SH-Timestamp': String(input.timestamp),
      'X-SH-Body-Sha256': bodySha256,
    },
    canonicalString,
    bodySha256,
  }
}

/** Lower-case every key of a header object (last-wins on a case collision). */
function lowercaseKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v
  return out
}

/**
 * Import a raw HMAC-SHA256 secret into a {@link CryptoKey} (ARCH-01). Convenience
 * wrapper over `crypto.subtle.importKey` with the algorithm fixed to
 * `{ name: 'HMAC', hash: 'SHA-256' }`.
 *
 * `usages` selects what the key may do: `['sign']` for a signer, `['verify']` for
 * the {@link verifySignature} server side, or `['sign', 'verify']` for tests that
 * do a full round-trip with one key. The raw secret is the shared per-client
 * signing secret — it lives only in the `SecretProvider` in production (SIGN-06),
 * never in code.
 */
export async function importHmacKey(
  rawSecret: ArrayBuffer | Uint8Array | string,
  usages: KeyUsage[] = ['sign'],
): Promise<CryptoKey> {
  const raw = typeof rawSecret === 'string' ? new TextEncoder().encode(rawSecret) : rawSecret
  return crypto.subtle.importKey(
    'raw',
    asBufferSource(raw),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  )
}

// Re-export the scheme + header-name constants from the one place they live, so a
// signer consumer needs only this module.
export { SH_HMAC_SHA256, AUTHORIZATION_HEADER, TIMESTAMP_HEADER, BODY_SHA256_HEADER }
