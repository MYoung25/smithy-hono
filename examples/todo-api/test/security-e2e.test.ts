/**
 * Phase S10 Part C — end-to-end security test matrix.
 *
 * Proves the FULLY-ASSEMBLED security pipeline composes correctly in front of the
 * REAL generated todo-api router. Each `it(...)` exercises one security domain's
 * headline behavior through Hono's in-memory client (`app.request`), naming the
 * requirement ID it covers.
 *
 * The pipeline order (createSecurityPipeline) — outermost → innermost — is:
 *   requestId, structuredLogger, errorSanitizer, securityHeaders, assertHttps,
 *   cors, bodyGuards, rateLimitPerIp, authenticate, verifySignature, csrf,
 *   rateLimitPerPrincipal  → THEN the router (zValidator → authorize → handler).
 *
 * NOTHING in the example app is edited; we build our OWN richly-configured
 * PipelineConfig and mount the real OPERATIONS + real createTodoRouter.
 */
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import {
  createSecurityPipeline,
  MemorySessionStore,
  MemoryRateLimitStore,
  MemoryNonceStore,
  MemorySecretProvider,
  signRequest,
  importHmacKey,
  type PipelineConfig,
  type SecurityEnv,
} from '@smithy-hono/security-core'
import { createTodoRouter, TodoNotFound, type TodoOperations, type Todo } from '../generated/todo.gen'
import { OPERATIONS } from '../generated/registry.gen'

// ── In-memory ops (mirrors auth.test.ts / behavior.test.ts) ───────────────────

function makeOps(): TodoOperations {
  const store = new Map<string, Todo>()
  let seq = 0
  return {
    async CreateTodo({ body }) {
      const todo: Todo = {
        id: `id-${++seq}`,
        title: body.title,
        done: body.done ?? false,
        createdAt: '2024-01-01T00:00:00.000Z',
      }
      store.set(todo.id, todo)
      return { item: todo }
    },
    async GetTodo({ id }) {
      const todo = store.get(id)
      if (!todo) throw new TodoNotFound(`Todo ${id} not found`)
      return { item: todo }
    },
    async ListTodos() { return { items: [] } },
    async DeleteTodo() {},
  }
}

// ── makeApp — a FRESH app + FRESH Memory stores per call (test isolation) ─────

interface AppHarness {
  app: Hono<SecurityEnv>
  stores: {
    session: MemorySessionStore
    rateLimit: MemoryRateLimitStore
    nonce: MemoryNonceStore
    secrets: MemorySecretProvider
  }
  config: PipelineConfig
}

function makeApp(overrides?: Partial<PipelineConfig>): AppHarness {
  const stores = {
    session: new MemorySessionStore(),
    rateLimit: new MemoryRateLimitStore(),
    nonce: new MemoryNonceStore(),
    secrets: new MemorySecretProvider(),
  }

  const config: PipelineConfig = {
    allowedOrigins: ['https://app.example.com'],
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
    idleTtlSeconds: 900,
    stores,
    // Default to https so the TLS test can override with http via the header.
    forwardedProtoHeader: (c) => c.req.header('x-forwarded-proto') ?? 'https',
    // Pin-able client IP so the rate-limit test gets its own bucket.
    clientIp: (c) => c.req.header('x-test-ip') ?? '127.0.0.1',
    maxBodyBytes: 1_048_576,
    protocolContentType: 'application/json',
    // No rateLimits by default — the limiter is graceful-off, never interferes.
    signing: { acceptanceWindowSeconds: 300, nonceForOps: [] },
    ...overrides,
  }

  const app = new Hono<SecurityEnv>()
  app.use('*', ...createSecurityPipeline(OPERATIONS, config))
  app.route('/', createTodoRouter(makeOps()))

  return { app, stores, config }
}

// ── Session seeding helper (tests 5 and 7) ────────────────────────────────────

const SID = 'sess-1'
const CSRF = 'csrf-1'

async function seedSession(store: MemorySessionStore, perms: string[] = ['todos.write', 'todos.read']) {
  await store.set(
    SID,
    {
      principal: { id: 'u1', permissions: perms, claims: {}, kind: 'user' },
      createdAt: Date.now(),
      absoluteExpiry: Date.now() + 3_600_000,
      csrfToken: CSRF,
      claims: {},
    },
    900,
  )
}

const HTTPS = { 'x-forwarded-proto': 'https' }

// ─────────────────────────────────────────────────────────────────────────────
// 1. AUTH-10 — unauthenticated request to an oidc op → uniform 401.
// ─────────────────────────────────────────────────────────────────────────────
describe('AUTH-10 — authentication', () => {
  it('GET /todos/:id with NO cookie → 401 { code: Unauthorized }', async () => {
    const { app } = makeApp()
    const res = await app.request('/todos/abc', { headers: { ...HTTPS } })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ code: 'Unauthorized' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. TLS-03 — spoofed plaintext forwarded-proto → 400 InsecureTransport.
// ─────────────────────────────────────────────────────────────────────────────
describe('TLS-03 — transport', () => {
  it('x-forwarded-proto: http → 400 { code: InsecureTransport }', async () => {
    const { app } = makeApp()
    const res = await app.request('/todos', { headers: { 'x-forwarded-proto': 'http' } })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ code: 'InsecureTransport', message: 'HTTPS required' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. VAL-04 — oversized body (declared Content-Length over cap) → 413.
// ─────────────────────────────────────────────────────────────────────────────
describe('VAL-04 — body size', () => {
  it('POST /todos over maxBodyBytes → 413 { code: PayloadTooLarge }', async () => {
    const { app } = makeApp({ maxBodyBytes: 16 })
    const body = JSON.stringify({ title: 'x'.repeat(200) }) // > 16 bytes
    const res = await app.request('/todos', {
      method: 'POST',
      headers: {
        ...HTTPS,
        'Content-Type': 'application/json',
        // The guard rejects on the DECLARED Content-Length before reading bytes
        // (VAL-04); app.request/undici doesn't always auto-set it, so be explicit.
        'Content-Length': String(new TextEncoder().encode(body).length),
      },
      body,
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ code: 'PayloadTooLarge' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. VAL-06 — wrong content-type → 415 UnsupportedMediaType.
// ─────────────────────────────────────────────────────────────────────────────
describe('VAL-06 — content type', () => {
  it('POST /todos with text/plain body → 415 { code: UnsupportedMediaType }', async () => {
    const { app } = makeApp()
    const res = await app.request('/todos', {
      method: 'POST',
      headers: { ...HTTPS, 'Content-Type': 'text/plain' },
      body: 'title=hi',
    })
    expect(res.status).toBe(415)
    expect(await res.json()).toEqual({ code: 'UnsupportedMediaType' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. VAL-03/08 — authed+CSRF-valid POST missing required `title` → 400
//    ValidationException, and NO field VALUE echoed in the response.
// ─────────────────────────────────────────────────────────────────────────────
describe('VAL-03/08 — validation', () => {
  it('POST /todos missing title → 400 ValidationException, no value echo', async () => {
    const { app, stores } = makeApp()
    await seedSession(stores.session)
    const secretValue = 'super-secret-value-should-not-echo'
    const res = await app.request('/todos', {
      method: 'POST',
      headers: {
        ...HTTPS,
        'Content-Type': 'application/json',
        Cookie: `__Host-session=${SID}`,
        'X-CSRF-Token': CSRF,
      },
      // `done` carries a recognizable value; `title` is missing (required).
      body: JSON.stringify({ done: true, note: secretValue }),
    })
    expect(res.status).toBe(400)
    const text = await res.text()
    const json = JSON.parse(text)
    expect(json.code).toBe('ValidationException')
    // The generated onError emits { code, fieldErrors:[{path,code}] } OR a Zod
    // message string; either way the SUBMITTED VALUE must never be echoed back.
    expect(text).not.toContain(secretValue)
    expect(text).not.toContain('super-secret')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. RATE-01/02 — tiny per-IP bucket; burst anonymous GET /todos → 429 +
//    integer Retry-After + ThrottlingException.
// ─────────────────────────────────────────────────────────────────────────────
describe('RATE-01/02 — rate limiting', () => {
  it('burst from a pinned IP drains the bucket → 429 + Retry-After + ThrottlingException', async () => {
    const { app } = makeApp({
      rateLimits: { perIp: { capacity: 2, refillPerSecond: 0.001 } },
    })
    const headers = { ...HTTPS, 'x-test-ip': '203.0.113.7' }

    const r1 = await app.request('/todos', { headers })
    expect(r1.status).toBe(200)
    const r2 = await app.request('/todos', { headers })
    expect(r2.status).toBe(200)
    const r3 = await app.request('/todos', { headers })
    expect(r3.status).toBe(429)

    const retryAfter = r3.headers.get('Retry-After')
    expect(retryAfter).not.toBeNull()
    expect(Number.isInteger(Number(retryAfter))).toBe(true)
    expect(await r3.json()).toEqual({ code: 'ThrottlingException', message: 'Too Many Requests' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. CSRF — cookie-authed POST without token → 403; with token → 201.
// ─────────────────────────────────────────────────────────────────────────────
describe('CSRF — synchronizer token', () => {
  it('cookie-authed POST /todos WITHOUT X-CSRF-Token → 403 { code: CsrfFailed }', async () => {
    const { app, stores } = makeApp()
    await seedSession(stores.session, ['todos.write'])
    const res = await app.request('/todos', {
      method: 'POST',
      headers: {
        ...HTTPS,
        'Content-Type': 'application/json',
        Cookie: `__Host-session=${SID}`,
      },
      body: JSON.stringify({ title: 'no csrf' }),
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ code: 'CsrfFailed' })
  })

  it('the SAME request WITH the correct X-CSRF-Token → 201', async () => {
    const { app, stores } = makeApp()
    await seedSession(stores.session, ['todos.write'])
    const res = await app.request('/todos', {
      method: 'POST',
      headers: {
        ...HTTPS,
        'Content-Type': 'application/json',
        Cookie: `__Host-session=${SID}`,
        'X-CSRF-Token': CSRF,
      },
      body: JSON.stringify({ title: 'with csrf' }),
    })
    expect(res.status).toBe(201)
    const json = (await res.json()) as { item: Todo }
    expect(json.item.title).toBe('with csrf')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. HDR/TLS/LOG — security headers + X-Request-Id on EVERY response.
// ─────────────────────────────────────────────────────────────────────────────
describe('HDR/TLS/LOG — response headers', () => {
  const SECURITY_HEADERS = [
    'Strict-Transport-Security',
    'X-Content-Type-Options',
    'X-Frame-Options',
    'Content-Security-Policy',
    'Referrer-Policy',
    'X-Request-Id',
  ]

  it('a 200 (GET /todos) carries the full hardened header set', async () => {
    const { app } = makeApp()
    const res = await app.request('/todos', { headers: { ...HTTPS } })
    expect(res.status).toBe(200)
    for (const h of SECURITY_HEADERS) expect(res.headers.get(h), h).not.toBeNull()
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('a 401 (rejected) response ALSO carries the full hardened header set', async () => {
    const { app } = makeApp()
    const res = await app.request('/todos/abc', { headers: { ...HTTPS } })
    expect(res.status).toBe(401)
    for (const h of SECURITY_HEADERS) expect(res.headers.get(h), h).not.toBeNull()
  })

  it('an inbound X-Request-Id is echoed back unchanged', async () => {
    const { app } = makeApp()
    const incoming = 'trace-abc123.def-456'
    const res = await app.request('/todos', { headers: { ...HTTPS, 'X-Request-Id': incoming } })
    expect(res.headers.get('X-Request-Id')).toBe(incoming)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 9. SIGN-* (S2S) — synthetic registry with one sigv4Hmac op. The todo model
//    has no S2S op, so we build a tiny OPERATIONS-shaped registry and mount the
//    real pipeline in front of a handler that echoes the established principal.
// ─────────────────────────────────────────────────────────────────────────────
describe('SIGN-* — S2S HMAC signing', () => {
  const KEY_ID = 'key-s2s'
  const SECRET = 'e2e-shared-secret-0123456789abcdef'

  const SYNTH_REGISTRY = {
    ImportTodos: {
      name: 'ImportTodos',
      method: 'POST' as const,
      path: '/s2s/import',
      authSchemes: [{ type: 'sigv4Hmac' as const }],
      readonly: false,
      requiredPermissions: [] as string[],
      cost: 1,
      constraints: { hasConstrainedInput: false },
    },
  }

  /** Build a fresh signing app. `nonceForOps` toggles replay tracking. */
  async function makeSigningApp(nonceForOps: string[] = []) {
    const signKey = await importHmacKey(SECRET, ['sign', 'verify'])
    const stores = {
      session: new MemorySessionStore(),
      rateLimit: new MemoryRateLimitStore(),
      nonce: new MemoryNonceStore(),
      secrets: new MemorySecretProvider(),
    }
    stores.secrets.addKey(KEY_ID, signKey, { clientId: 'svc-a', current: true })

    const config: PipelineConfig = {
      allowedOrigins: ['https://app.example.com'],
      hsts: { maxAge: 31_536_000, includeSubDomains: true },
      idleTtlSeconds: 900,
      stores,
      forwardedProtoHeader: (c) => c.req.header('x-forwarded-proto') ?? 'https',
      clientIp: (c) => c.req.header('x-test-ip') ?? '127.0.0.1',
      maxBodyBytes: 1_048_576,
      protocolContentType: 'application/json',
      signing: { acceptanceWindowSeconds: 300, nonceForOps },
    }

    const app = new Hono<SecurityEnv>()
    app.use('*', ...createSecurityPipeline(SYNTH_REGISTRY, config))
    app.post('/s2s/import', (c) => {
      const principal = c.get('principal')
      return c.json({ kind: principal?.kind ?? null, id: principal?.id ?? null }, 201)
    })
    return { app, signKey }
  }

  const URL = 'http://localhost/s2s/import'

  async function signed(signKey: CryptoKey, opts?: { body?: string; ts?: number }) {
    const body = opts?.body ?? JSON.stringify({ items: [] })
    const ts = opts?.ts ?? Math.floor(Date.now() / 1000)
    const baseHeaders: Record<string, string> = {
      Host: 'localhost',
      'Content-Type': 'application/json',
    }
    const s = await signRequest({
      method: 'POST',
      url: URL,
      headers: baseHeaders,
      body,
      keyId: KEY_ID,
      key: signKey,
      signedHeaders: ['host', 'content-type'],
      timestamp: ts,
    })
    return {
      init: {
        method: 'POST',
        headers: { ...baseHeaders, ...s.headers, 'x-forwarded-proto': 'https' },
        body,
      } as RequestInit,
    }
  }

  it('(a) a valid signature → handler reached, principal.kind === service', async () => {
    const { app, signKey } = await makeSigningApp()
    const { init } = await signed(signKey)
    const res = await app.request(URL, init)
    expect(res.status).toBe(201)
    const json = (await res.json()) as { kind: string; id: string }
    expect(json.kind).toBe('service')
    expect(json.id).toBe(KEY_ID)
  })

  it('(b) a tampered body → 401', async () => {
    const { app, signKey } = await makeSigningApp()
    const { init } = await signed(signKey, { body: JSON.stringify({ items: [] }) })
    // Mutate the body AFTER signing — the X-SH-Body-Sha256 / canonical no longer match.
    init.body = JSON.stringify({ items: [{ title: 'injected' }] })
    const res = await app.request(URL, init)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ code: 'Unauthorized' })
  })

  it('(c) a timestamp outside the acceptance window → 401', async () => {
    const { app, signKey } = await makeSigningApp()
    const stale = Math.floor(Date.now() / 1000) - 301 // window is 300s
    const { init } = await signed(signKey, { ts: stale })
    const res = await app.request(URL, init)
    expect(res.status).toBe(401)
  })

  it('(d) replay of the same signature on a nonceForOps op → first 201, second 401', async () => {
    const { app, signKey } = await makeSigningApp(['ImportTodos'])
    const { init } = await signed(signKey)
    const first = await app.request(URL, { ...init })
    expect(first.status).toBe(201)
    // Replay the SAME signed request — same signature → nonce store rejects it.
    const second = await app.request(URL, { ...init })
    expect(second.status).toBe(401)
  })
})
