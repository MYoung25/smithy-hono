import { Hono } from 'hono'
import {
  createSecurityPipeline,
  MemorySessionStore,
  MemoryRateLimitStore,
  MemoryNonceStore,
  MemorySecretProvider,
  signRequest,
  importHmacKey,
  DEFAULT_SESSION_COOKIE_NAME,
  type OperationRegistry,
  type PipelineConfig,
  type SecurityEnv,
  type Principal,
} from '@smithy-hono/security-core'
import { inMemoryFetch, type FetchLike } from './transport.js'
import { principal as makePrincipal, isPrincipal, sessionRecord, type SessionOptions } from './builders.js'

// ── The shape of a GENERATED client factory (createXClient) ───────────────────

export interface ClientOptionsLike {
  fetch?: FetchLike
  baseUrl?: string
  headers?: () => HeadersInit | Promise<HeadersInit>
}

/** A generated `createXClient` factory — the kit is generic over the client type. */
export type ClientFactory<C> = (opts?: ClientOptionsLike) => C

// ── Stores ────────────────────────────────────────────────────────────────────

export interface TestStores {
  session: MemorySessionStore
  rateLimit: MemoryRateLimitStore
  nonce: MemoryNonceStore
  secrets: MemorySecretProvider
}

function freshStores(): TestStores {
  return {
    session: new MemorySessionStore(),
    rateLimit: new MemoryRateLimitStore(),
    nonce: new MemoryNonceStore(),
    secrets: new MemorySecretProvider(),
  }
}

/** Every distinct permission any operation requires — used for a superuser test principal. */
export function allPermissions(operations: OperationRegistry): string[] {
  const set = new Set<string>()
  for (const op of Object.values(operations)) {
    for (const perm of op.requiredPermissions ?? []) set.add(perm)
  }
  return [...set]
}

/** A fully-authorized principal that can reach every operation in the registry. */
export function superuser(operations: OperationRegistry): Principal {
  return makePrincipal({ id: 'test-superuser', permissions: allPermissions(operations) })
}

// ── Test defaults for the security pipeline (mirrors the example e2e config) ───

function baseConfig(stores: TestStores, overrides?: Partial<PipelineConfig>): PipelineConfig {
  return {
    allowedOrigins: ['https://app.example.com'],
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
    idleTtlSeconds: 900,
    stores,
    // Default to https so routes pass the TLS check; a test can send x-forwarded-proto: http to assert TLS-03.
    forwardedProtoHeader: (c) => c.req.header('x-forwarded-proto') ?? 'https',
    // Pin-able per-IP bucket for rate-limit tests.
    clientIp: (c) => c.req.header('x-test-ip') ?? '127.0.0.1',
    maxBodyBytes: 1_048_576,
    protocolContentType: 'application/json',
    signing: { acceptanceWindowSeconds: 300, nonceForOps: [] },
    ...overrides,
  }
}

// ── Harness ─────────────────────────────────────────────────────────────────--

export interface HarnessOptions<C> {
  /** The generated `OPERATIONS` registry (registry.gen.ts). */
  operations: OperationRegistry
  /** The generated router mounted in front of your ops, e.g. `createTodoRouter(ops)`. */
  router: Hono
  /** The generated client factory, e.g. `createTodoClient`. */
  createClient: ClientFactory<C>
  /** Overrides merged over the test-default PipelineConfig. */
  config?: Partial<PipelineConfig>
}

export interface AuthedClient<C> {
  client: C
  sessionId: string
  csrfToken: string
  principal: Principal
}

export interface ServiceAuthOptions {
  keyId: string
  /** Raw HMAC secret (hex or text) — imported via importHmacKey. */
  secret: string
  clientId?: string
  signedHeaders?: string[]
  /** Absolute origin the client targets (so signing can parse path/query). Default http://localhost. */
  baseUrl?: string
}

export interface Harness<C> {
  /** The assembled Hono app (full security pipeline → router). Escape hatch. */
  app: Hono<SecurityEnv>
  /** Fresh in-memory stores — seed or assert against them. */
  stores: TestStores
  /** The resolved PipelineConfig. */
  config: PipelineConfig
  /** An UNAUTHENTICATED client (anonymous routes only). */
  client: C
  /**
   * A client whose every request carries a valid session cookie + CSRF token. Seeds a
   * session in `stores.session`. With no argument, the principal is a superuser that can
   * reach every operation; pass a {@link Principal} or {@link SessionOptions} to scope it.
   */
  loginAs(principalOrOptions?: Principal | SessionOptions): Promise<AuthedClient<C>>
  /**
   * A client that HMAC-signs every request (S2S, `@sigv4Hmac` ops). Registers the key in
   * `stores.secrets` and signs with `SH-HMAC-SHA256` via the in-memory transport.
   */
  asService(opts: ServiceAuthOptions): Promise<C>
}

const HTTPS_DEFAULT = { 'x-forwarded-proto': 'https' }

/**
 * The INTEGRATION harness: mounts the full `createSecurityPipeline` in front of the
 * generated router with fresh in-memory stores, and hands back a generated client wired
 * to the app in-process. This is the real request path — auth, CSRF, rate-limit, headers,
 * validation, the lot — driven type-safely.
 */
export function createTestHarness<C>(opts: HarnessOptions<C>): Harness<C> {
  const stores = freshStores()
  const config = baseConfig(stores, opts.config)

  const app = new Hono<SecurityEnv>()
  app.use('*', ...createSecurityPipeline(opts.operations, config))
  app.route('/', opts.router)

  const client = opts.createClient({ fetch: inMemoryFetch(app, { defaultHeaders: HTTPS_DEFAULT }) })

  // Per-harness counter so two `loginAs()` calls with no explicit sessionId get DISTINCT
  // default session ids instead of both aliasing onto 'test-session' (which would make the
  // second call's principal silently overwrite the first under one cookie key).
  let loginSeq = 0

  async function loginAs(arg?: Principal | SessionOptions): Promise<AuthedClient<C>> {
    const sessionOpts: SessionOptions = isPrincipal(arg)
      ? { principal: arg }
      : { ...(arg as SessionOptions) }
    if (!sessionOpts.principal) sessionOpts.principal = superuser(opts.operations)
    const sessionId = sessionOpts.sessionId ?? `test-session-${++loginSeq}`
    const record = sessionRecord({ ...sessionOpts, sessionId })

    await stores.session.set(sessionId, record, sessionOpts.ttlSeconds ?? 3600)

    const authedFetch = inMemoryFetch(app, {
      defaultHeaders: {
        ...HTTPS_DEFAULT,
        cookie: `${DEFAULT_SESSION_COOKIE_NAME}=${sessionId}`,
        'x-csrf-token': record.csrfToken,
      },
    })
    return {
      client: opts.createClient({ fetch: authedFetch }),
      sessionId,
      csrfToken: record.csrfToken,
      principal: record.principal,
    }
  }

  async function asService(svc: ServiceAuthOptions): Promise<C> {
    const key = await importHmacKey(svc.secret, ['sign', 'verify'])
    const clientId = svc.clientId ?? 'test-service'
    stores.secrets.addKey(svc.keyId, key, { clientId, current: true })

    const baseUrl = svc.baseUrl ?? 'http://localhost'
    const host = new URL(baseUrl).host
    const signedHeaders = svc.signedHeaders ?? ['host', 'content-type']

    const signingFetch = inMemoryFetch(app, {
      defaultHeaders: { ...HTTPS_DEFAULT, host },
      sign: async (req) => {
        const headerObj: Record<string, string> = {}
        req.headers.forEach((value, name) => { headerObj[name] = value })
        const signed = await signRequest({
          method: req.method,
          url: req.url,
          headers: headerObj,
          body: req.body,
          keyId: svc.keyId,
          key,
          signedHeaders,
          timestamp: Math.floor(Date.now() / 1000),
        })
        return signed.headers
      },
    })
    return opts.createClient({ baseUrl, fetch: signingFetch })
  }

  return { app, stores, config, client, loginAs, asService }
}

// ── Unit harness (router only, no pipeline) ───────────────────────────────────

export interface MountOptions<C> {
  /** The generated router, e.g. `createTodoRouter(ops)`. */
  router: Hono
  /** The generated client factory, e.g. `createTodoClient`. */
  createClient: ClientFactory<C>
  /**
   * Stand-in for the pipeline's `authenticate` phase:
   *  - omitted + `operations` given → a superuser principal (reaches every route);
   *  - a {@link Principal}            → that principal;
   *  - `null`                         → NO principal (simulates unauthenticated).
   */
  principal?: Principal | null
  /** When set and `principal` is omitted, the default principal is a superuser for these. */
  operations?: OperationRegistry
}

export interface MountedRouter<C> {
  app: Hono<SecurityEnv>
  client: C
}

/**
 * The UNIT harness: mounts JUST the generated router (no security pipeline) behind a
 * middleware that sets a stand-in `principal`. Use this to exercise your operation
 * handlers + the generated validators/authorize hook without the full pipeline.
 */
export function mountRouter<C>(opts: MountOptions<C>): MountedRouter<C> {
  const app = new Hono<SecurityEnv>()
  if (opts.principal !== null) {
    const p = opts.principal
      ?? (opts.operations ? superuser(opts.operations) : makePrincipal())
    app.use('*', async (c, next) => {
      c.set('principal', p)
      await next()
    })
  }
  app.route('/', opts.router)
  return { app, client: opts.createClient({ fetch: inMemoryFetch(app) }) }
}
