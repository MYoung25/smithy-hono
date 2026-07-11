/**
 * OIDC ID-token verifier tests (RT-03).
 *
 * Generates a local EC keypair + JWKS in-test (no network), signs valid/invalid
 * tokens with jose, and asserts the verifier's accept/reject behavior across
 * signature, iss, aud, exp, iat, and nonce.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  createLocalJWKSet,
  type JWK,
  type KeyLike,
} from 'jose'
import {
  createOidcVerifier,
  verifyIdToken,
  assertVerifiedClaims,
  OidcVerificationError,
  OidcConfigError,
  type OidcConfig,
  type VerifiedClaims,
} from './oidc.js'

const ISSUER = 'https://idp.example.com'
const AUDIENCE = 'client-abc'
const ALG = 'ES256'
const KID = 'test-key-1'

let privateKey: KeyLike
let jwks: { keys: JWK[] }
// A second, UNTRUSTED keypair whose public key is NOT in the JWKS — used to
// forge a token with a valid signature over the wrong key (tamper test).
let attackerKey: KeyLike

beforeAll(async () => {
  const pair = await generateKeyPair(ALG)
  privateKey = pair.privateKey
  const pubJwk = await exportJWK(pair.publicKey)
  pubJwk.kid = KID
  pubJwk.alg = ALG
  jwks = { keys: [pubJwk] }

  const attacker = await generateKeyPair(ALG)
  attackerKey = attacker.privateKey
})

/** Build the verifier config backed by the local JWKS (no network). */
function config(overrides: Partial<OidcConfig> = {}): OidcConfig {
  return {
    issuer: ISSUER,
    audience: AUDIENCE,
    jwks: createLocalJWKSet(jwks),
    ...overrides,
  }
}

interface TokenOpts {
  iss?: string
  aud?: string | string[]
  sub?: string
  nonce?: string
  azp?: string
  expiresIn?: string // jose relative, e.g. '1h' / '-1h'
  iat?: number // explicit iat override
  omitIat?: boolean
  signWith?: KeyLike
  kid?: string
}

/** Sign an ID token with the (default trusted) key. */
async function signToken(opts: TokenOpts = {}): Promise<string> {
  const jwt = new SignJWT({
    ...(opts.nonce !== undefined ? { nonce: opts.nonce } : {}),
    ...(opts.azp !== undefined ? { azp: opts.azp } : {}),
  })
    .setProtectedHeader({ alg: ALG, kid: opts.kid ?? KID })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUDIENCE)
    .setSubject(opts.sub ?? 'user-123')
    .setExpirationTime(opts.expiresIn ?? '1h')

  if (!opts.omitIat) jwt.setIssuedAt(opts.iat)

  return jwt.sign((opts.signWith ?? privateKey) as Parameters<typeof jwt.sign>[0])
}

describe('verifyIdToken (RT-03) — valid token', () => {
  it('accepts a valid token and returns branded verified claims', async () => {
    const token = await signToken({ sub: 'alice', nonce: 'n-1' })
    const claims = await verifyIdToken(config(), token, { nonce: 'n-1' })
    expect(claims.sub).toBe('alice')
    expect(claims.iss).toBe(ISSUER)
    expect(claims.nonce).toBe('n-1')
    // The branded value is structurally a claims bag.
    expect(typeof claims.exp).toBe('number')
    expect(typeof claims.iat).toBe('number')
  })

  it('accepts when no nonce is expected (nonce check skipped)', async () => {
    const token = await signToken({ sub: 'bob' })
    const claims = await verifyIdToken(config(), token)
    expect(claims.sub).toBe('bob')
  })

  it('accepts an array audience containing the expected aud (with matching azp)', async () => {
    // Multi-audience tokens MUST carry an azp equal to our client id (OIDC Core
    // §3.1.3.7, AUTH-SESSION-01); azp is asserted separately in its own block.
    const token = await signToken({ aud: ['other', AUDIENCE], azp: AUDIENCE })
    const claims = await verifyIdToken(config(), token)
    expect(claims.sub).toBe('user-123')
  })
})

describe('verifyIdToken (RT-03) — rejections', () => {
  it('rejects a TAMPERED signature (signed by an untrusted key)', async () => {
    // Signed with the attacker key but advertising the trusted kid → not in JWKS.
    const token = await signToken({ signWith: attackerKey })
    await expect(verifyIdToken(config(), token)).rejects.toThrow(OidcVerificationError)
  })

  it('rejects a token with a garbled signature segment', async () => {
    const token = await signToken()
    const tampered = token.slice(0, -3) + (token.endsWith('AAA') ? 'BBB' : 'AAA')
    await expect(verifyIdToken(config(), tampered)).rejects.toThrow(OidcVerificationError)
  })

  it('rejects an EXPIRED token (exp in the past)', async () => {
    const token = await signToken({ expiresIn: '-1h' })
    await expect(verifyIdToken(config(), token)).rejects.toThrow(OidcVerificationError)
  })

  it('rejects the WRONG audience', async () => {
    const token = await signToken({ aud: 'someone-else' })
    await expect(verifyIdToken(config(), token)).rejects.toThrow(OidcVerificationError)
  })

  it('rejects the WRONG issuer', async () => {
    const token = await signToken({ iss: 'https://evil.example.com' })
    await expect(verifyIdToken(config(), token)).rejects.toThrow(OidcVerificationError)
  })

  it('rejects a MISMATCHED nonce', async () => {
    const token = await signToken({ nonce: 'real-nonce' })
    await expect(
      verifyIdToken(config(), token, { nonce: 'expected-other' }),
    ).rejects.toThrow(OidcVerificationError)
  })

  it('rejects a MISSING nonce when one is expected', async () => {
    const token = await signToken() // no nonce claim
    await expect(verifyIdToken(config(), token, { nonce: 'expected' })).rejects.toThrow(
      OidcVerificationError,
    )
  })

  it('rejects a token missing iat (requiredClaims)', async () => {
    const token = await signToken({ omitIat: true })
    await expect(verifyIdToken(config(), token)).rejects.toThrow(OidcVerificationError)
  })
})

describe('createOidcVerifier — empty-audience guard (finding config-validate-2)', () => {
  it('throws OidcConfigError for an empty-string audience', async () => {
    await expect(createOidcVerifier(config({ audience: '' }))).rejects.toThrow(OidcConfigError)
  })

  it('throws OidcConfigError for an all-empty array audience', async () => {
    await expect(createOidcVerifier(config({ audience: ['', '  '] }))).rejects.toThrow(OidcConfigError)
  })

  it('accepts a non-empty audience', async () => {
    await expect(createOidcVerifier(config())).resolves.toBeDefined()
  })
})

describe('verifyIdToken — requireNonce opt-in (finding auth-session-2)', () => {
  it('throws when requireNonce is set but no nonce is supplied', async () => {
    const token = await signToken({ nonce: 'n-1' })
    await expect(
      verifyIdToken(config(), token, { requireNonce: true }),
    ).rejects.toThrow(OidcVerificationError)
  })

  it('still verifies when requireNonce and a matching nonce are both supplied', async () => {
    const token = await signToken({ sub: 'carol', nonce: 'n-1' })
    const claims = await verifyIdToken(config(), token, { nonce: 'n-1', requireNonce: true })
    expect(claims.sub).toBe('carol')
  })

  it('default (no requireNonce, no nonce) still skips the check — behavior unchanged', async () => {
    const token = await signToken({ sub: 'dave' })
    const claims = await verifyIdToken(config(), token)
    expect(claims.sub).toBe('dave')
  })
})

describe('verifyIdToken (AUTH-SESSION-01) — azp (authorized party) binding', () => {
  it('rejects an azp naming a DIFFERENT client (token substitution)', async () => {
    // aud contains our client but azp says the token was issued for another RP.
    const token = await signToken({ aud: AUDIENCE, azp: 'someone-else' })
    await expect(verifyIdToken(config(), token)).rejects.toThrow(OidcVerificationError)
  })

  it('rejects a multi-audience token whose azp names a different client', async () => {
    const token = await signToken({ aud: ['other', AUDIENCE], azp: 'other' })
    await expect(verifyIdToken(config(), token)).rejects.toThrow(OidcVerificationError)
  })

  it('rejects a multi-audience token that omits azp (azp is required there)', async () => {
    const token = await signToken({ aud: ['other', AUDIENCE] })
    await expect(verifyIdToken(config(), token)).rejects.toThrow(OidcVerificationError)
  })

  it('accepts a token whose azp equals our client id', async () => {
    const token = await signToken({ aud: AUDIENCE, azp: AUDIENCE, sub: 'carol' })
    const claims = await verifyIdToken(config(), token)
    expect(claims.sub).toBe('carol')
  })

  it('accepts a multi-audience token whose azp equals our client id', async () => {
    const token = await signToken({ aud: ['other', AUDIENCE], azp: AUDIENCE, sub: 'dave' })
    const claims = await verifyIdToken(config(), token)
    expect(claims.sub).toBe('dave')
  })

  it('uses an explicit clientId for azp when audience is an array', async () => {
    // audience is an array (no single-string fallback) → clientId must be set.
    const token = await signToken({ aud: ['svc-a', 'svc-b'], azp: 'svc-b', sub: 'erin' })
    await expect(
      verifyIdToken(config({ audience: ['svc-a', 'svc-b'], clientId: 'svc-a' }), token),
    ).rejects.toThrow(OidcVerificationError)
    const claims = await verifyIdToken(
      config({ audience: ['svc-a', 'svc-b'], clientId: 'svc-b' }),
      token,
    )
    expect(claims.sub).toBe('erin')
  })
})

describe('createOidcVerifier — reuse + discovery', () => {
  it('reuses one verifier across multiple tokens', async () => {
    const verifier = await createOidcVerifier(config())
    const a = await verifier.verify(await signToken({ sub: 'a' }))
    const b = await verifier.verify(await signToken({ sub: 'b' }))
    expect(a.sub).toBe('a')
    expect(b.sub).toBe('b')
  })

  it('discovers the jwks_uri from the issuer well-known document', async () => {
    // The verifier's discovery step uses Web-standard `fetch` (stubbed here);
    // it builds a remote JWKS set targeting the DISCOVERED uri. (We assert the
    // discovery contract — the well-known doc is fetched and jwks_uri honored —
    // rather than driving jose's remote JWKS HTTP, which under Node uses
    // node:http and is exercised by the local-JWKS verification tests above.)
    const realFetch = globalThis.fetch
    const wellKnown = `${ISSUER}/.well-known/openid-configuration`
    const jwksUri = `${ISSUER}/jwks`
    let discoveryHit = false
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === wellKnown) {
        discoveryHit = true
        return new Response(JSON.stringify({ issuer: ISSUER, jwks_uri: jwksUri }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch

    try {
      const verifier = await createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE })
      expect(discoveryHit).toBe(true)
      expect(typeof verifier.verify).toBe('function')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('throws OidcVerificationError when discovery fails', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('nope', { status: 500 })) as typeof fetch
    try {
      await expect(
        createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE }),
      ).rejects.toThrow(OidcVerificationError)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('assertVerifiedClaims (RT-03 runtime brand backstop)', () => {
  it('passes for a plausibly-verified claims object', () => {
    const v = { sub: 's', iss: 'i', exp: 123 }
    expect(() => assertVerifiedClaims(v)).not.toThrow()
  })

  it('throws for a raw object missing sub/iss/exp', () => {
    expect(() => assertVerifiedClaims({ foo: 'bar' })).toThrow(OidcVerificationError)
    expect(() => assertVerifiedClaims(null)).toThrow(OidcVerificationError)
    expect(() => assertVerifiedClaims({ sub: 'x' })).toThrow(OidcVerificationError)
  })

  it('narrows to VerifiedClaims after the assertion', () => {
    const v: unknown = { sub: 's', iss: 'i', exp: 1 }
    assertVerifiedClaims(v)
    // After the assertion, v is VerifiedClaims (type-level); read a branded field.
    const claims: VerifiedClaims = v
    expect(claims.sub).toBe('s')
  })
})
