import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { verifySignature } from './verifySignature.js'
import type { SigningModuleConfig } from './verifySignature.js'
import { signRequest, importHmacKey } from './signer.js'
import { MemorySecretProvider, MemoryNonceStore } from '../storage/memory.js'
import type { SecurityConfig, AuditEvent, AuditSink } from '../config.js'
import type { SecurityEnv } from '../pipeline/context.js'
import { defaultPseudonymize, pseudonymize } from '../audit/audit.js'

const SECRET = 'verify-shared-secret-0123456789'
const KEY_ID = 'key-cur'

/** Captures emitted audit events for assertions. */
class FakeAuditSink implements AuditSink {
  events: AuditEvent[] = []
  async emit(e: AuditEvent): Promise<void> {
    this.events.push(e)
  }
}

/** Resolver factory: every route is sigv4Hmac with the given op name. */
function hmacResolve(name = 'CreateTodo', scheme: string = 'sigv4Hmac') {
  return () => ({ name, authSchemes: [{ type: scheme }] })
}

async function makeKey(usages: KeyUsage[] = ['sign', 'verify']) {
  return importHmacKey(SECRET, usages)
}

interface Ctx {
  secrets: MemorySecretProvider
  signKey: CryptoKey
}

async function setup(): Promise<Ctx> {
  const key = await makeKey()
  const secrets = new MemorySecretProvider()
  secrets.addKey(KEY_ID, key, { clientId: 'svc', current: true })
  return { secrets, signKey: key }
}

function makeConfig(over: Partial<SecurityConfig & SigningModuleConfig> = {}): SecurityConfig &
  SigningModuleConfig {
  return {
    allowedOrigins: [],
    hsts: { maxAge: 0, includeSubDomains: false },
    idleTtlSeconds: 900,
    signing: { acceptanceWindowSeconds: 300, nonceForOps: [] },
    stores: {},
    // Most cases here exercise something OTHER than replay defense and wire no
    // nonce store; opt into the (replayable) no-store fallback so they aren't
    // denied by the SIGNING-03 fail-closed default. Cases that test the fail-closed
    // default / real replay tracking override this explicitly.
    allowReplayWithoutNonceStore: true,
    ...over,
  }
}

const TS = () => Math.floor(Date.now() / 1000)

async function sign(
  signKey: CryptoKey,
  opts: { keyId?: string; ts?: number; body?: string } = {},
) {
  const body = opts.body ?? JSON.stringify({ title: 't' })
  const headers = { Host: 'localhost', 'Content-Type': 'application/json' }
  const signed = await signRequest({
    method: 'POST',
    url: 'http://localhost/todos',
    headers,
    body,
    keyId: opts.keyId ?? KEY_ID,
    key: signKey,
    signedHeaders: ['host', 'content-type'],
    timestamp: opts.ts ?? TS(),
  })
  return {
    headers: { ...headers, ...signed.headers } as Record<string, string>,
    body,
  }
}

function app(config: SecurityConfig & SigningModuleConfig, name = 'CreateTodo', scheme = 'sigv4Hmac') {
  const a = new Hono<SecurityEnv>()
  a.use('*', verifySignature(config, hmacResolve(name, scheme)))
  a.post('/todos', (c) => c.json({ kind: c.get('principal')?.kind ?? null }))
  a.get('/todos', (c) => c.json({ kind: c.get('principal')?.kind ?? null }))
  return a
}

describe('verifySignature — SIGN-02 timestamp window', () => {
  it('accepts a timestamp just inside the window', async () => {
    const { secrets, signKey } = await setup()
    const cfg = makeConfig({ stores: { secrets } })
    const { headers, body } = await sign(signKey, { ts: TS() - 299 })
    const res = await app(cfg).request('http://localhost/todos', {
      method: 'POST',
      headers,
      body,
    })
    expect(res.status).toBe(200)
  })

  it('rejects a timestamp just outside the window (stale_timestamp)', async () => {
    const { secrets, signKey } = await setup()
    const audit = new FakeAuditSink()
    const cfg = makeConfig({ stores: { secrets }, audit })
    const { headers, body } = await sign(signKey, { ts: TS() - 600 })
    const res = await app(cfg).request('http://localhost/todos', {
      method: 'POST',
      headers,
      body,
    })
    expect(res.status).toBe(401)
    expect(audit.events.at(-1)).toMatchObject({
      type: 'sig.fail',
      outcome: 'deny',
      detail: { reason: 'stale_timestamp' },
    })
  })

  it('rejects a future-dated timestamp beyond the forward skew (SIGNING-02)', async () => {
    const { secrets, signKey } = await setup()
    const audit = new FakeAuditSink()
    const cfg = makeConfig({ stores: { secrets }, audit })
    // Far in the future but still inside the symmetric ±window — the asymmetric
    // forward clamp (default 30s) rejects it as stale.
    const { headers, body } = await sign(signKey, { ts: TS() + 200 })
    const res = await app(cfg).request('http://localhost/todos', {
      method: 'POST',
      headers,
      body,
    })
    expect(res.status).toBe(401)
    expect(audit.events.at(-1)).toMatchObject({ detail: { reason: 'stale_timestamp' } })
  })

  it('accepts a slightly future-dated timestamp within the forward skew', async () => {
    const { secrets, signKey } = await setup()
    const cfg = makeConfig({ stores: { secrets } })
    const { headers, body } = await sign(signKey, { ts: TS() + 5 })
    const res = await app(cfg).request('http://localhost/todos', {
      method: 'POST',
      headers,
      body,
    })
    expect(res.status).toBe(200)
  })

  it('honors a custom maxForwardSkewSeconds (restores symmetric window)', async () => {
    const { secrets, signKey } = await setup()
    const cfg = makeConfig({ stores: { secrets }, maxForwardSkewSeconds: 300 })
    const { headers, body } = await sign(signKey, { ts: TS() + 200 })
    const res = await app(cfg).request('http://localhost/todos', {
      method: 'POST',
      headers,
      body,
    })
    expect(res.status).toBe(200)
  })

  it('rejects a non-numeric timestamp (bad_timestamp)', async () => {
    const { secrets, signKey } = await setup()
    const cfg = makeConfig({ stores: { secrets } })
    const { headers, body } = await sign(signKey)
    headers['X-SH-Timestamp'] = 'not-a-number'
    const res = await app(cfg).request('http://localhost/todos', {
      method: 'POST',
      headers,
      body,
    })
    expect(res.status).toBe(401)
  })
})

describe('verifySignature — SIGN-05 key rotation', () => {
  it('rejects an unknown / retired keyId (unknown_key)', async () => {
    const { secrets, signKey } = await setup()
    const audit = new FakeAuditSink()
    const cfg = makeConfig({ stores: { secrets }, audit })
    const { headers, body } = await sign(signKey, { keyId: 'key-retired' })
    const res = await app(cfg).request('http://localhost/todos', {
      method: 'POST',
      headers,
      body,
    })
    expect(res.status).toBe(401)
    expect(audit.events.at(-1)).toMatchObject({ detail: { reason: 'unknown_key' } })
  })

  it('accepts a request signed with the PREVIOUS key during rotation overlap', async () => {
    // Two keys live in the provider simultaneously (current + previous, SIGN-05).
    const prevKey = await importHmacKey('previous-secret-aaaaaaaaaa', ['sign', 'verify'])
    const curKey = await makeKey()
    const secrets = new MemorySecretProvider()
    secrets.addKey('key-cur', curKey, { clientId: 'svc', current: true })
    secrets.addKey('key-prev', prevKey) // previous, still resolvable
    const cfg = makeConfig({ stores: { secrets } })

    const { headers, body } = await sign(prevKey, { keyId: 'key-prev' })
    const res = await app(cfg).request('http://localhost/todos', {
      method: 'POST',
      headers,
      body,
    })
    expect(res.status).toBe(200)
  })
})

describe('verifySignature — SIGN-07 body hash', () => {
  it('rejects a client-declared body hash that does not match (body_hash_mismatch)', async () => {
    const { secrets, signKey } = await setup()
    const audit = new FakeAuditSink()
    const cfg = makeConfig({ stores: { secrets }, audit })
    const { headers, body } = await sign(signKey)
    headers['X-SH-Body-Sha256'] = 'deadbeef' // lie about the body hash
    const res = await app(cfg).request('http://localhost/todos', {
      method: 'POST',
      headers,
      body,
    })
    expect(res.status).toBe(401)
    expect(audit.events.at(-1)).toMatchObject({ detail: { reason: 'body_hash_mismatch' } })
  })

  it('rejects UNSIGNED-PAYLOAD as the declared body hash', async () => {
    const { secrets, signKey } = await setup()
    const cfg = makeConfig({ stores: { secrets } })
    const { headers, body } = await sign(signKey)
    headers['X-SH-Body-Sha256'] = 'UNSIGNED-PAYLOAD'
    const res = await app(cfg).request('http://localhost/todos', {
      method: 'POST',
      headers,
      body,
    })
    expect(res.status).toBe(401)
  })
})

describe('verifySignature — SIGN-03 replay (nonce)', () => {
  it('first request passes, an identical replay is rejected (replay)', async () => {
    const { secrets, signKey } = await setup()
    const audit = new FakeAuditSink()
    const nonce = new MemoryNonceStore()
    const cfg = makeConfig({
      stores: { secrets, nonce },
      signing: { acceptanceWindowSeconds: 300, nonceForOps: ['CreateTodo'] },
      audit,
    })
    const a = app(cfg)
    const { headers, body } = await sign(signKey)

    const first = await a.request('http://localhost/todos', { method: 'POST', headers, body })
    expect(first.status).toBe(200)

    // Replay the exact same signed request.
    const second = await a.request('http://localhost/todos', { method: 'POST', headers, body })
    expect(second.status).toBe(401)
    expect(audit.events.at(-1)).toMatchObject({ detail: { reason: 'replay' } })
  })

  it('rejects a nonce-op when no nonce store is wired (fail closed)', async () => {
    const { secrets, signKey } = await setup()
    const cfg = makeConfig({
      stores: { secrets },
      signing: { acceptanceWindowSeconds: 300, nonceForOps: ['CreateTodo'] },
    })
    const { headers, body } = await sign(signKey)
    const res = await app(cfg).request('http://localhost/todos', { method: 'POST', headers, body })
    expect(res.status).toBe(401)
  })

  // RT-06: replay tracking is opt-OUT. A resolver that sets the op's readonly flag.
  function roResolve(name: string, readonly: boolean, scheme = 'sigv4Hmac') {
    return () => ({ name, readonly, authSchemes: [{ type: scheme }] })
  }
  function appRO(cfg: SecurityConfig & SigningModuleConfig, name: string, readonly: boolean) {
    const a = new Hono<SecurityEnv>()
    a.use('*', verifySignature(cfg, roResolve(name, readonly)))
    a.post('/todos', (c) => c.json({ ok: true }))
    return a
  }

  it('rejects a replayed signature on a non-readonly op BY DEFAULT (no per-op config)', async () => {
    const { secrets, signKey } = await setup()
    const nonce = new MemoryNonceStore()
    const cfg = makeConfig({ stores: { secrets, nonce }, signing: { acceptanceWindowSeconds: 300 } })
    const a = appRO(cfg, 'Transfer', false)
    const { headers, body } = await sign(signKey)
    expect((await a.request('http://localhost/todos', { method: 'POST', headers, body })).status).toBe(200)
    expect((await a.request('http://localhost/todos', { method: 'POST', headers, body })).status).toBe(401)
  })

  it('skips nonce for a @readonly signed op (idempotent — replay allowed)', async () => {
    const { secrets, signKey } = await setup()
    const nonce = new MemoryNonceStore()
    const cfg = makeConfig({ stores: { secrets, nonce }, signing: { acceptanceWindowSeconds: 300 } })
    const a = appRO(cfg, 'GetThing', true)
    const { headers, body } = await sign(signKey)
    expect((await a.request('http://localhost/todos', { method: 'POST', headers, body })).status).toBe(200)
    expect((await a.request('http://localhost/todos', { method: 'POST', headers, body })).status).toBe(200)
  })

  it('honors replaySafeOps to exempt a non-readonly op from tracking', async () => {
    const { secrets, signKey } = await setup()
    const nonce = new MemoryNonceStore()
    const cfg = makeConfig({
      stores: { secrets, nonce },
      signing: { acceptanceWindowSeconds: 300, replaySafeOps: ['Transfer'] },
    })
    const a = appRO(cfg, 'Transfer', false)
    const { headers, body } = await sign(signKey)
    expect((await a.request('http://localhost/todos', { method: 'POST', headers, body })).status).toBe(200)
    expect((await a.request('http://localhost/todos', { method: 'POST', headers, body })).status).toBe(200)
  })

  it('forces nonce on a @readonly op via nonceForOps', async () => {
    const { secrets, signKey } = await setup()
    const nonce = new MemoryNonceStore()
    const cfg = makeConfig({
      stores: { secrets, nonce },
      signing: { acceptanceWindowSeconds: 300, nonceForOps: ['GetThing'] },
    })
    const a = appRO(cfg, 'GetThing', true)
    const { headers, body } = await sign(signKey)
    expect((await a.request('http://localhost/todos', { method: 'POST', headers, body })).status).toBe(200)
    expect((await a.request('http://localhost/todos', { method: 'POST', headers, body })).status).toBe(401)
  })

  it('fails closed BY DEFAULT when a non-readonly op has no NonceStore (SIGNING-03)', async () => {
    const { secrets, signKey } = await setup()
    const audit = new FakeAuditSink()
    const cfg = makeConfig({
      stores: { secrets },
      signing: { acceptanceWindowSeconds: 300 },
      allowReplayWithoutNonceStore: false,
      audit,
    })
    const a = appRO(cfg, 'Transfer', false)
    const { headers, body } = await sign(signKey)
    // No nonce store + non-readonly op → replay defense absent → deny, not serve.
    expect((await a.request('http://localhost/todos', { method: 'POST', headers, body })).status).toBe(401)
    expect(audit.events.at(-1)).toMatchObject({ detail: { reason: 'replay' } })
  })

  it('warns and proceeds when allowReplayWithoutNonceStore is explicitly set', async () => {
    const { secrets, signKey } = await setup()
    const warnings: Record<string, unknown>[] = []
    const cfg = makeConfig({
      stores: { secrets },
      signing: { acceptanceWindowSeconds: 300 },
      allowReplayWithoutNonceStore: true,
      logger: { info() {}, warn: (r) => warnings.push(r), error() {} },
    })
    const a = appRO(cfg, 'Transfer', false)
    const { headers, body } = await sign(signKey)
    expect((await a.request('http://localhost/todos', { method: 'POST', headers, body })).status).toBe(200)
    expect((await a.request('http://localhost/todos', { method: 'POST', headers, body })).status).toBe(200)
    expect(warnings.some((w) => w.event === 'signing.replay_unprotected')).toBe(true)
    // Warned at most once per op.
    expect(warnings.filter((w) => w.event === 'signing.replay_unprotected').length).toBe(1)
  })
})

describe('verifySignature — SIGNING-04 mandatory signed-header floor', () => {
  /** Sign with a caller-chosen signedHeaders list (so we can OMIT host). */
  async function signWith(signKey: CryptoKey, signedHeaders: string[]) {
    const body = JSON.stringify({ title: 't' })
    const headers = { Host: 'localhost', 'Content-Type': 'application/json' }
    const signed = await signRequest({
      method: 'POST',
      url: 'http://localhost/todos',
      headers,
      body,
      keyId: KEY_ID,
      key: signKey,
      signedHeaders,
      timestamp: TS(),
    })
    return { headers: { ...headers, ...signed.headers } as Record<string, string>, body }
  }

  it('rejects a signature that omits a required header (host) by default', async () => {
    const { secrets, signKey } = await setup()
    const audit = new FakeAuditSink()
    const cfg = makeConfig({ stores: { secrets }, audit })
    const { headers, body } = await signWith(signKey, ['content-type'])
    const res = await app(cfg).request('http://localhost/todos', { method: 'POST', headers, body })
    expect(res.status).toBe(401)
    expect(audit.events.at(-1)).toMatchObject({ detail: { reason: 'missing_required_header' } })
  })

  it('accepts a signature that includes the required header', async () => {
    const { secrets, signKey } = await setup()
    const cfg = makeConfig({ stores: { secrets } })
    const { headers, body } = await signWith(signKey, ['host', 'content-type'])
    const res = await app(cfg).request('http://localhost/todos', { method: 'POST', headers, body })
    expect(res.status).toBe(200)
  })

  it('an empty requiredSignedHeaders disables the floor', async () => {
    const { secrets, signKey } = await setup()
    const cfg = makeConfig({ stores: { secrets }, requiredSignedHeaders: [] })
    const { headers, body } = await signWith(signKey, ['content-type'])
    const res = await app(cfg).request('http://localhost/todos', { method: 'POST', headers, body })
    expect(res.status).toBe(200)
  })
})

describe('verifySignature — pass-through & fail-closed', () => {
  it('passes a non-HMAC op (oidc) straight through untouched', async () => {
    const { secrets } = await setup()
    const cfg = makeConfig({ stores: { secrets } })
    const res = await app(cfg, 'ListTodos', 'oidc').request('http://localhost/todos', {
      method: 'GET',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ kind: null }) // no principal set here
  })

  it('passes an anonymous op through untouched', async () => {
    const { secrets } = await setup()
    const cfg = makeConfig({ stores: { secrets } })
    const res = await app(cfg, 'ListTodos', 'anonymous').request('http://localhost/todos', {
      method: 'GET',
    })
    expect(res.status).toBe(200)
  })

  it('401s a HMAC op when no secrets backend is wired (no_secret_backend)', async () => {
    const { signKey } = await setup()
    const audit = new FakeAuditSink()
    const cfg = makeConfig({ stores: {}, audit })
    const { headers, body } = await sign(signKey)
    const res = await app(cfg).request('http://localhost/todos', { method: 'POST', headers, body })
    expect(res.status).toBe(401)
    expect(audit.events.at(-1)).toMatchObject({ detail: { reason: 'no_secret_backend' } })
  })

  it('401s on a malformed Authorization header (malformed_auth)', async () => {
    const { secrets } = await setup()
    const cfg = makeConfig({ stores: { secrets } })
    const res = await app(cfg).request('http://localhost/todos', {
      method: 'POST',
      headers: { Host: 'localhost', 'Content-Type': 'application/json', Authorization: 'garbage' },
      body: '{}',
    })
    expect(res.status).toBe(401)
  })
})

describe('verifySignature — SIGN-11 service principal', () => {
  it('sets a default scoped service principal (kind:service) on success', async () => {
    const { secrets, signKey } = await setup()
    const cfg = makeConfig({ stores: { secrets } })
    const { headers, body } = await sign(signKey)
    const res = await app(cfg).request('http://localhost/todos', { method: 'POST', headers, body })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ kind: 'service' })
  })

  it('uses a custom signingPrincipalMapper to grant scopes', async () => {
    const { secrets, signKey } = await setup()
    const cfg = makeConfig({
      stores: { secrets },
      signingPrincipalMapper: (keyId) => ({
        id: `svc:${keyId}`,
        permissions: ['todos.write'],
        claims: {},
        kind: 'service',
      }),
    })
    const a = new Hono<SecurityEnv>()
    a.use('*', verifySignature(cfg, hmacResolve()))
    a.post('/todos', (c) => {
      const p = c.get('principal')
      return c.json({ id: p?.id, perms: p?.permissions })
    })
    const { headers, body } = await sign(signKey)
    const res = await a.request('http://localhost/todos', { method: 'POST', headers, body })
    expect(await res.json()).toEqual({ id: `svc:${KEY_ID}`, perms: ['todos.write'] })
  })

  it('emits an auth.success audit event on a verified request', async () => {
    const { secrets, signKey } = await setup()
    const audit = new FakeAuditSink()
    const cfg = makeConfig({ stores: { secrets }, audit })
    const { headers, body } = await sign(signKey)
    await app(cfg).request('http://localhost/todos', { method: 'POST', headers, body })
    expect(audit.events.at(-1)).toMatchObject({ type: 'auth.success', outcome: 'allow' })
    // principalRef is pseudonymized — never the raw keyId.
    expect(audit.events.at(-1)?.principalRef).not.toBe(KEY_ID)
    expect(audit.events.at(-1)?.principalRef).toBeTruthy()
  })

  // AUDIT-LOGGING-03 — with no auditSalt, the principalRef must go through the
  // NAMED insecure dev/test fallback (defaultPseudonymize), NOT a silent bare
  // unsalted SHA-256, matching pipeline/logging.ts.
  it('uses defaultPseudonymize for the principalRef when auditSalt is unset', async () => {
    const { secrets, signKey } = await setup()
    const audit = new FakeAuditSink()
    const cfg = makeConfig({ stores: { secrets }, audit }) // no auditSalt
    const { headers, body } = await sign(signKey)
    await app(cfg).request('http://localhost/todos', { method: 'POST', headers, body })
    expect(audit.events.at(-1)?.principalRef).toBe(await defaultPseudonymize(KEY_ID))
  })

  it('uses the keyed HMAC for the principalRef when auditSalt IS set', async () => {
    const { secrets, signKey } = await setup()
    const audit = new FakeAuditSink()
    const auditSalt = 'a-high-entropy-deployment-salt-0123456789'
    const cfg = makeConfig({ stores: { secrets }, audit, auditSalt })
    const { headers, body } = await sign(signKey)
    await app(cfg).request('http://localhost/todos', { method: 'POST', headers, body })
    expect(audit.events.at(-1)?.principalRef).toBe(await pseudonymize(KEY_ID, auditSalt))
  })
})
