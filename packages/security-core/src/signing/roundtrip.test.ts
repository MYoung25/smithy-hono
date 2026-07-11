/**
 * The headline correctness gate (SIGN v1): sign with the reference signer, verify
 * with the pipeline middleware, byte-exact round-trip. The signer is the
 * verifier's oracle — they share `./canonical.js`, so a green round-trip proves
 * the two cannot diverge. Tampering any signed input flips the result to 401.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { Hono } from 'hono'
import { verifySignature } from './verifySignature.js'
import { signRequest, importHmacKey } from './signer.js'
import { MemorySecretProvider } from '../storage/memory.js'
import type { SecurityConfig } from '../config.js'
import type { SecurityEnv } from '../pipeline/context.js'

const SECRET = 'roundtrip-shared-secret-0123456789'
const KEY_ID = 'key-rt'

/** An HMAC op resolver — every route is sigv4Hmac so the verifier engages. */
function hmacResolve(name = 'CreateTodo') {
  return () => ({ name, authSchemes: [{ type: 'sigv4Hmac' as const }] })
}

let signKey: CryptoKey
let secrets: MemorySecretProvider

beforeAll(async () => {
  // One key, both usages: the signer signs and the provider's key verifies.
  const both = await importHmacKey(SECRET, ['sign', 'verify'])
  signKey = both
  secrets = new MemorySecretProvider()
  secrets.addKey(KEY_ID, both, { clientId: 'svc-a', current: true })
})

function makeConfig(): SecurityConfig {
  return {
    allowedOrigins: [],
    hsts: { maxAge: 0, includeSubDomains: false },
    idleTtlSeconds: 900,
    signing: { acceptanceWindowSeconds: 300, nonceForOps: [] },
    stores: { secrets },
    // Roundtrip exercises the sign→verify byte-exactness, not replay defense; no
    // nonce store is wired here, so opt into the no-store fallback to avoid the
    // SIGNING-03 fail-closed default.
    allowReplayWithoutNonceStore: true,
  } as SecurityConfig
}

/** Build an app whose handler echoes the principal AND re-reads the JSON body. */
function buildApp() {
  const app = new Hono<SecurityEnv>()
  app.use('*', verifySignature(makeConfig(), hmacResolve()))
  app.post('/todos', async (c) => {
    const principal = c.get('principal')
    // Proves the body survived readRawBody — the deserializer still parses.
    const body = await c.req.json()
    return c.json({ kind: principal?.kind ?? null, id: principal?.id ?? null, body })
  })
  return app
}

const TS = () => Math.floor(Date.now() / 1000)

async function signedRequest(opts?: {
  body?: string
  method?: string
  ts?: number
  extraHeaders?: Record<string, string>
}) {
  const body = opts?.body ?? JSON.stringify({ title: 'buy milk' })
  const method = opts?.method ?? 'POST'
  const ts = opts?.ts ?? TS()
  const url = 'http://localhost/todos'
  const baseHeaders: Record<string, string> = {
    Host: 'localhost',
    'Content-Type': 'application/json',
  }
  const signed = await signRequest({
    method,
    url,
    headers: baseHeaders,
    body,
    keyId: KEY_ID,
    key: signKey,
    signedHeaders: ['host', 'content-type'],
    timestamp: ts,
  })
  return {
    url,
    init: {
      method,
      headers: { ...baseHeaders, ...signed.headers, ...(opts?.extraHeaders ?? {}) },
      body: method === 'GET' ? undefined : body,
    } as RequestInit,
  }
}

describe('roundtrip — sign → verify (the gate)', () => {
  it('a freshly signed request PASSES and yields a service principal', async () => {
    const app = buildApp()
    const { url, init } = await signedRequest()
    const res = await app.request(url, init)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.kind).toBe('service')
    expect(json.id).toBe(KEY_ID)
    // The downstream c.req.json() still parsed the same body (readRawBody safe).
    expect(json.body).toEqual({ title: 'buy milk' })
  })

  it('a tampered body → 401', async () => {
    const app = buildApp()
    const { url, init } = await signedRequest()
    // Mutate the body after signing — the re-derived hash no longer matches.
    init.body = JSON.stringify({ title: 'buy gold' })
    const res = await app.request(url, init)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ code: 'Unauthorized' })
  })

  it('a tampered signed header (host) → 401', async () => {
    const app = buildApp()
    const { url, init } = await signedRequest()
    ;(init.headers as Record<string, string>)['Host'] = 'evil.example.com'
    const res = await app.request(url, init)
    expect(res.status).toBe(401)
  })

  it('a tampered method → 401', async () => {
    const app = buildApp()
    const { url, init } = await signedRequest()
    // Sign as POST but the verifier sees the swapped method in the canonical str.
    init.method = 'PUT'
    const app2 = new Hono<SecurityEnv>()
    app2.use('*', verifySignature(makeConfig(), hmacResolve()))
    app2.put('/todos', (c) => c.json({ ok: true }))
    const res = await app2.request(url, init)
    expect(res.status).toBe(401)
    expect(app).toBeDefined()
  })

  it('a tampered signature hex → 401', async () => {
    const app = buildApp()
    const { url, init } = await signedRequest()
    const auth = (init.headers as Record<string, string>)['Authorization']
    ;(init.headers as Record<string, string>)['Authorization'] = auth.replace(
      /signature=[0-9a-f]/,
      'signature=0',
    )
    const res = await app.request(url, init)
    expect(res.status).toBe(401)
  })
})
