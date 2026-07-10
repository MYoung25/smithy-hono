---
id: testing
title: Testing a service
sidebar_label: Testing
sidebar_position: 2
---

# Testing a smithy-hono service

smithy-hono gives you two things that make a generated service testable with almost no
boilerplate:

1. A **generated typed client** (`<stem>.client.gen.ts`) emitted alongside the router by
   the same codegen — so client and server agree on the wire contract by construction.
2. **`@smithy-hono/test-kit`** — harnesses that drive that client against your
   router/pipeline **in-process** (no network), plus auth helpers, builders, and
   assertions.

## The generated client

Every build emits a `create<Service>Client(opts?)` factory (disable with
`"emitClient": false` in `smithy-build.json`). It uses only Web-standard `fetch`:

```ts
import { createTodoClient } from './generated'

// Production: real fetch + base URL.
const client = createTodoClient({ baseUrl: 'https://api.example.com' })
const { item } = await client.CreateTodo({ body: { title: 'x' } }) // typed in/out
// Modeled errors are thrown as the generated error classes:
//   try { await client.GetTodo({ id }) } catch (e) { if (e instanceof TodoNotFound) … }
```

Options: `fetch` (default `globalThis.fetch`), `baseUrl` (default `''`), and `headers`
(a hook returning headers merged into every request — auth, tracing, etc.).

## Testing with @smithy-hono/test-kit

```
npm i -D @smithy-hono/test-kit
```

Unit (router only, stand-in principal):

```ts
import { mountRouter, expectError } from '@smithy-hono/test-kit'
import { createTodoRouter, createTodoClient, TodoNotFound } from '../generated'
import { OPERATIONS } from '../generated/registry.gen'

const { client } = mountRouter({ router: createTodoRouter(ops), createClient: createTodoClient, operations: OPERATIONS })
await client.CreateTodo({ body: { title: 'x' } })
await expectError(() => client.GetTodo({ id: 'nope' }), TodoNotFound)
```

Integration (full security pipeline + in-memory stores, with auth helpers):

```ts
import { createTestHarness } from '@smithy-hono/test-kit'

const h = createTestHarness({ operations: OPERATIONS, router: createTodoRouter(ops), createClient: createTodoClient })
const { client } = await h.loginAs()        // seeds a session, attaches cookie + CSRF
await client.CreateTodo({ body: { title: 'x' } })
const svc = await h.asService({ keyId, secret })   // HMAC-signs each request (@sigv4Hmac ops)
```

See `packages/test-kit/README.md` for the full surface (builders, assertions, MCP client,
`asService`, raw-request escape hatches). Worked examples live in
`examples/todo-api/test/` — `behavior.test.ts` / `auth.test.ts` (unit),
`harness-e2e.test.ts` (integration), `client-roundtrip.test.ts` (client↔router),
`mcp-auth-e2e.test.ts` (MCP).
