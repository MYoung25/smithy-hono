# @smithy-hono/test-kit

Testing toolkit for **smithy-hono** services. It makes unit and integration testing of a
generated service ridiculously easy by driving the **generated typed client** against your
router/pipeline **in-process** (no network, no ports), plus auth helpers, builders, and
assertions.

Everything is Web-standard only (ARCH-01), so it runs in any test environment (node,
workers, jsdom) and under any runner (vitest, node:test, jest).

```
npm i -D @smithy-hono/test-kit
```

Peers you already have in a smithy-hono service: `@smithy-hono/security-core`, `hono`.

---

## The two harnesses

| | `mountRouter` (unit) | `createTestHarness` (integration) |
|---|---|---|
| What runs | just the generated router | full `createSecurityPipeline` → router |
| Auth | a stand-in `principal` you set | real `authenticate` (cookies), `loginAs`/`asService` |
| Stores | none | fresh in-memory Session/RateLimit/Nonce/Secret per harness |
| Use for | handler logic, validators, the `authorize` hook | auth, CSRF, rate-limit, headers, signing, e2e flows |

Both hand you the **generated typed client** wired to the app — calls are type-safe and
modeled errors come back as the **same generated error classes** the server throws.

---

## Unit: `mountRouter`

```ts
import { mountRouter, expectError } from '@smithy-hono/test-kit'
import { createTodoRouter, createTodoClient, TodoNotFound } from '../generated'
import { OPERATIONS } from '../generated/registry.gen'

const { client, app } = mountRouter({
  router: createTodoRouter(myOps),
  createClient: createTodoClient,
  operations: OPERATIONS,        // default principal = a superuser that reaches every route
})

const { item } = await client.CreateTodo({ body: { title: 'x' } })   // typed I/O
await expectError(() => client.GetTodo({ id: 'nope' }), TodoNotFound) // typed error
```

`principal` controls the stand-in identity:

```ts
mountRouter({ router, createClient, principal: principal({ permissions: ['todos.read'] }) })
mountRouter({ router, createClient, principal: null })   // simulate an unauthenticated request
```

Use the returned `app` (raw `app.request`) for cases the typed client can't express — a
malformed JSON body, a missing required field, etc.

---

## Integration: `createTestHarness`

```ts
import { createTestHarness, principal } from '@smithy-hono/test-kit'
import { createTodoRouter, createTodoClient } from '../generated'
import { OPERATIONS } from '../generated/registry.gen'

const h = createTestHarness({
  operations: OPERATIONS,
  router: createTodoRouter(myOps),
  createClient: createTodoClient,
  // config?: Partial<PipelineConfig>   // merged over test defaults (https, json, pinnable IP)
})

h.client      // unauthenticated client (anonymous routes only)
h.stores      // { session, rateLimit, nonce, secrets } — seed / assert
h.app         // the assembled Hono app (escape hatch for raw requests)
```

### `loginAs` — cookie + CSRF, handled for you

```ts
const { client } = await h.loginAs()                                   // superuser by default
await client.CreateTodo({ body: { title: 'via pipeline' } })           // cookie + CSRF attached

const { client: reader } = await h.loginAs(principal({ permissions: ['todos.read'] }))
```

`loginAs` seeds a real session in `h.stores.session` and returns a client whose every
request carries the session cookie and the matching `X-CSRF-Token`.

### `asService` — HMAC request signing (`@sigv4Hmac` ops)

```ts
const svc = await h.asService({ keyId: 'key-1', secret: 'shared-secret-…' })
await svc.ImportThings({ body: { items: [] } })   // each request is SH-HMAC-SHA256 signed
```

Registers the key in `h.stores.secrets` and signs every outgoing request via the in-memory
transport.

---

## Builders

```ts
import { principal, sessionRecord, fakeContext } from '@smithy-hono/test-kit'

principal({ permissions: ['todos.write'], id: 'u1', kind: 'user', tenantId: 't1' })
sessionRecord({ principal: principal(), csrfToken: 'tok', ttlSeconds: 3600 })

// Unit-test a handler directly (no HTTP):
const c = fakeContext({ principal: principal({ id: 'u1' }) })
await myOps.GetTodo({ id: 'x' }, c)
```

---

## Assertions (runner-agnostic)

```ts
import { expectError, catchError, expectStatus } from '@smithy-hono/test-kit'

const err = await expectError(() => client.GetTodo({ id: 'x' }), TodoNotFound)
expect(err.$statusCode).toBe(404)

await expectStatus(() => app.request('/todos', { method: 'POST', body: 'not-json' }), 400)
```

Authz rejections (`{ code: 'Unauthorized' | 'AccessDenied' }`) aren't modeled errors, so the
generated client throws a `SmithyError` carrying the status — assert on `$statusCode`:

```ts
import { SmithyError } from '../generated'
const e = await expectError(() => client.CreateTodo({ body: { title: 'x' } }), SmithyError)
expect(e.$statusCode).toBe(403)
```

Prefer your runner's native matchers? They work too:
`await expect(client.GetTodo({ id: 'x' })).rejects.toBeInstanceOf(TodoNotFound)`.

---

## MCP

```ts
import { createMcpClient } from '@smithy-hono/test-kit'

const mcp = createMcpClient(myMcpApp)                       // injects https + JSON-RPC envelope
await mcp.listTools()                                       // public discovery
await mcp.callTool('CreateTodo', { body: { title: 'x' } }, { token: 'writer' })
```

---

## How it works

The generated client takes a `fetch`-shaped function. The kit supplies one built on Hono's
in-memory `app.request` (`inMemoryFetch`), and that single function is where cookies, CSRF
tokens, and HMAC signatures are injected — the client stays oblivious. Because the same
codegen emits the server and the client, they agree on the wire contract by construction.
