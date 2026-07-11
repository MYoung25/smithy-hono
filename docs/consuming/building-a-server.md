---
id: building-a-server
title: Building a server
sidebar_label: Building a server
sidebar_position: 1
---

# Building a server: model → codegen → Hono app

This is the end-to-end runtime story. It assumes you've already wired the
registry auth and the plugin jar per the [README](./README.md). Secure the
result with [`security.md`](./security.md); ship it with
[`deployment.md`](./deployment.md).

- [Step 1 — author your model](#step-1--author-your-model)
- [Step 2 — run codegen (Gradle)](#step-2--run-codegen-gradle)
- [What the codegen emits](#what-the-codegen-emits)
- [Step 3 — pick an implementation style](#step-3--pick-an-implementation-style)
- [Choosing a DataStore](#choosing-a-datastore)
- [Assembling the Hono app](#assembling-the-hono-app)
- [Error handling](#error-handling)
- [Pagination](#pagination)
- [SSE / streaming (read before you rely on it)](#sse--streaming-read-before-you-rely-on-it)
- [MCP exposure](#mcp-exposure)
- [Testing with test-kit](#testing-with-test-kit)

---

## Step 1 — author your model

Write a normal Smithy service. To use smithy-hono's features, `use` the traits
from the `com.smithyhono` namespace:

```smithy
$version: "2.0"
namespace com.example.todo

use com.smithyhono#requiresAuth
use com.smithyhono#cost
use com.smithyhono#persisted
use com.smithyhono#sigv4Hmac
use com.smithyhono#mcpPrompts
```

The consumer-facing traits (verbatim members from
`model/traits.smithy`):

| Trait | Applies to | Members | Effect |
| --- | --- | --- | --- |
| `@requiresAuth` | operation | `permission: String` (omit = any authenticated user) | Operation is auth-gated; the named permission is checked against the principal's permission set. Emits an `authorize(OPERATIONS.<Op>)` middleware call in the router. |
| `@cost` | operation | `value: Integer` (required) | Relative cost for the runtime rate limiter (default 1 when absent). |
| `@sigv4Hmac` | operation | *(empty)* | Requires the custom **SH-HMAC-SHA256** service-to-service signing scheme; surfaces as `authSchemes: [{ type: 'sigv4Hmac' }]` in the registry. |
| `@sseEvent` | structure | `eventType: String` (required) | Marks a struct as an SSE event type; `eventType` becomes the SSE `event:` field. Produces `events.gen.ts`. |
| `@sseStream` | operation | *(empty)* | Marks an HTTP op as a streaming SSE endpoint → `streaming: true` in the registry. **Does not generate a streaming handler** — see [SSE](#sse--streaming-read-before-you-rely-on-it). |
| `@persisted` | resource | `table`, `timestamps` (default true), `softDelete` (default false), `optimisticConcurrency` (default off), `ownerField`, `tenantField`, `indexes` | Generates default DB-backed CRUD over a `DataStore`. Bare `@persisted` = all defaults. `ownerField`/`tenantField` are auto-injected from `principal.id` / `principal.tenantId` and scope list/read. |
| `@mcpPrompts` | service or operation | `list` of `McpPrompt { name?, description?, arguments?, template (required) }` | Declares MCP prompts (templated, never dispatch ops). On an operation, omit `arguments` to auto-derive from input members. Produces `MCP_PROMPTS`. |

Pagination uses the **standard Smithy `@paginated` trait** (cursor pattern) —
see [Pagination](#pagination).

> ⚠️ **Do I need to copy `model/traits.smithy`? Yes — always.** Copy
> `model/traits.smithy` from this repo into your
> model package's `model/` directory alongside your own `.smithy` files. The
> plugin jar registers the traits as Java `TraitService` providers
> (`META-INF/services/...TraitService`), but it does **not** package the trait
> *shape definitions* as a loadable Smithy model resource (there is no
> `META-INF/smithy` in the jar). The providers handle trait *deserialization*,
> but the IDL `use com.smithyhono#persisted` / `@persisted` needs the trait
> *shape* present during model assembly. Without the copied file, `smithy build`
> fails: *"Use statement refers to undefined shape: com.smithyhono#persisted"* and
> *"Unable to resolve trait `com.smithyhono#persisted`"* (verified empirically;
> adding the file makes codegen succeed). The file is small and changes rarely;
> re-copy it when you upgrade the plugin version.

For the full authoring surface (HTTP bindings, error categories, type mappings)
see [`Codegen plugin guide`](../authoring/codegen-plugin-guide.md) — don't
duplicate it; the table above is the consumer-relevant subset.

---

## Step 2 — run codegen (Gradle)

Use the complete `build.gradle.kts.example`. Three
gotchas, all handled there:

1. **Apply the `java` plugin.** The Smithy `smithy-base` plugin only creates the
   `smithyBuild` configuration when `java` is applied. Without it,
   `add("smithyBuild", "com.smithy-hono:smithy-hono:0.1.1")` silently does
   nothing — a silent failure where traits won't resolve.
2. **Add the dependency to the `smithyBuild` configuration** with
   `add("smithyBuild", "...")` (the typed `smithyBuild(...)` accessor only exists
   if the configuration is already created).
3. **`outputDirectory` is ignored by the Gradle plugin.** Generated code lands
   in `build/smithyprojections/<rootProject.name>/source/hono-codegen/`. You must
   copy it into your source tree yourself, **excluding `*.template.ts`**:

```kotlin
tasks.register<Copy>("syncGeneratedCode") {
    dependsOn("smithyBuild")
    val gen = layout.buildDirectory.dir("smithyprojections/${project.name}/source/hono-codegen")
    from(gen) {
        include("*.ts")
        exclude("*.template.ts")   // copy-once references — never overwrite hand-edited copies
    }
    into("src/generated")
}
```

Wire it into your npm scripts so `npm run codegen` regenerates and syncs:

```json
{
  "scripts": {
    "codegen": "./gradlew syncGeneratedCode",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

> The in-repo `examples/*` apps commit their `generated/` directories and have no
> per-example `build.gradle.kts`; they regenerate from the repo root with
> `./gradlew smithyBuild`. The pattern above is what a standalone consumer needs.
> The exact `copy { ... include("*.ts"); exclude("*.template.ts") }` rule is the
> same one this repo uses for its own typecheck fixtures (see
> `build.gradle.kts`, `typeCheck` task).

---

## What the codegen emits

Generated files are named after each resource "group" (file stem = kebab-cased
group name; below, the `TaskService` from
`examples/crud-api/generated`). Every
`*.gen.ts` carries `// DO NOT EDIT — regenerated by smithy-hono on every build`.

| File | Always? | Key exports |
| --- | --- | --- |
| `<stem>.gen.ts` | yes | Zod schemas + types, error classes, the `Operations` interface, the `Middleware` interface, the **router factory** |
| `registry.gen.ts` | yes | `OPERATIONS`, `OPERATION_BY_ROUTE`, the `OperationMeta` / `AuthScheme` types |
| `index.ts` | yes | barrel re-export |
| `<stem>.client.gen.ts` | yes | typed `fetch` client (`create<Stem>Client`) |
| `errors.ts` | yes | runtime base `SmithyError` / `SmithyErrorShape` / `MODELED_ERROR_BRAND` (emitted verbatim, identical for all consumers) |
| `<stem>.crud.gen.ts` | only with `@persisted` | `createDefault<Group>Operations(store, hooks?)` |
| `permissions.gen.ts` | only with `@requiresAuth` perms | `Permissions` const + `Permission` type |
| `mcp.gen.ts` | only with MCP | `MCP_TOOLS`, `MCP_PROMPTS` |
| `events.gen.ts` + `events.template.ts` | only with `@sseEvent` | `<Service>EventEmitter`, `<Service>EventSource`, `<Service>Event` (`.gen`); copy-once SSE router (`.template`) |
| `shared.gen.ts` | only multi-group | Zod schemas/types reachable from 2+ groups |
| `errors.gen.ts` | only multi-group | error classes shared by 2+ groups (hoisted) |
| `client-runtime.gen.ts` | only multi-group | the shared `FetchLike` interface |

> In a single-group service (like crud-api), error classes are inlined into
> `<stem>.gen.ts` and `shared.gen.ts` / `errors.gen.ts` / `client-runtime.gen.ts`
> do **not** exist. Don't import from files that aren't there.

**Router factory** (`<stem>.gen.ts`):

```ts
export function createTaskRouter(ops: TaskOperations, middleware?: TaskMiddleware): Hono
```

Pattern: `create<Group>Router(ops, middleware?)`. The optional `middleware`
carries per-op middleware slots:

```ts
export interface TaskMiddleware {
  all?: MiddlewareHandler[]      // runs for every operation
  CreateTask?: MiddlewareHandler[]
  GetTask?: MiddlewareHandler[]
  // ...one optional slot per operation
}
```

Slot middleware runs before the generated `zValidator` and the handler — this is
where resource-authorization policies are dropped (see
[`security.md`](./security.md#resource-level-authorization)).

**The `Operations` interface** is the hand-written-handler contract:

```ts
export interface TaskOperations {
  CreateTask(input: { body: TaskBody }, c?: Context<SecurityEnv>): Promise<CreateTaskOutput>
  DeleteTask(input: { id: string }, c?: Context<SecurityEnv>): Promise<void>
  GetTask(input: { id: string }, c?: Context<SecurityEnv>): Promise<GetTaskOutput>
  ListTasks(input: { nextToken?: string; maxResults?: number }, c?: Context<SecurityEnv>): Promise<ListTasksOutput>
  UpdateTask(input: { id: string; body: TaskBody }, c?: Context<SecurityEnv>): Promise<UpdateTaskOutput>
}
```

**The registry** (`registry.gen.ts`) is the metadata the security pipeline and
MCP bridge consume:

```ts
export const OPERATIONS: Record<string, OperationMeta> = {
  CreateTask: {
    name: 'CreateTask',
    method: 'POST',
    path: '/tasks',
    authSchemes: [{ type: 'anonymous' }],   // or { type: 'oidc' } / { type: 'sigv4Hmac' }
    readonly: false,
    requiredPermissions: [],
    cost: 1,
    resource: 'Task',
    crudVerb: 'create',
    identifierMembers: ['id'],
    // streaming?: boolean, pagination?, sensitiveFields? when present
  },
  // ...
}
```

---

## Step 3 — pick an implementation style

### A. Zero-handler `@persisted` CRUD

If a resource is `@persisted`, codegen emits a factory that implements the whole
`Operations` interface over a `DataStore`. You write **no handler code**. From
`examples/crud-api/src/createApp.ts`:

```ts
import { Hono } from 'hono'
import { createMemoryDataStore } from '@smithy-hono/data-core/memory'
import { createTaskRouter, type TaskData } from '../generated/task.gen'
import { createDefaultTaskOperations } from '../generated/task.crud.gen'

const store = createMemoryDataStore<TaskData>()
const ops = createDefaultTaskOperations(store)   // zero handler code
const app = new Hono()
app.route('/', createTaskRouter(ops))
```

The factory signature is `createDefault<Group>Operations(store: DataStore<R>,
hooks?: <Group>Hooks)`, where **`R` is the resource's data struct type** (here
`TaskData`, imported from `<stem>.gen.ts`). The `Hooks` object lets you intercept
without rewriting: `beforeCreate` / `afterRead` / `beforeUpdate` / `beforeDelete`
/ `filterList`.

### B. Hand-written handlers

For non-`@persisted` resources or custom service operations, implement the
`Operations` interface yourself. From
`examples/todo-api/src/implementation.ts`:

```ts
import type { TodoOperations } from '../generated/todo.gen'
import { TodoNotFound } from '../generated/todo.gen'

const store = new Map<string, Todo>()
export const todoOps: TodoOperations = {
  async CreateTodo(input) { /* ... */ },
  async GetTodo(input) {
    const todo = store.get(input.id)
    if (!todo) throw new TodoNotFound(`todo ${input.id} not found`)
    return { item: todo }
  },
  // ...
}
```

Throw the generated error classes; the router serializes them (see
[Error handling](#error-handling)).

### C. Mixing both

A model can have `@persisted` resources *and* custom operations. Use
`createDefault<Group>Operations` for the persisted ones and hand-write the
custom service ops, then mount each router. This is the recommended pattern for
real services (CRUD-heavy resources auto-generated, business logic hand-written).

---

## Choosing a DataStore

The `DataStore<T>` interface (from `@smithy-hono/data-core`) is the single
abstraction; every adapter returns it. Methods: `get` / `create` / `put` /
`update` / `patch` / `delete` / `list` / optional `count`, each taking a
`DataScope { tenantId?, ownerId? }` for owner/tenant scoping. Optimistic
concurrency surfaces as `OptimisticConflictError`.

| Platform | Install | Construct |
| --- | --- | --- |
| **Dev / test (memory)** | `@smithy-hono/data-core` | `createMemoryDataStore<T>({ softDelete? })` (from `@smithy-hono/data-core/memory`) |
| **Node + Redis** | `@smithy-hono/adapter-node` + `ioredis` | `createRedisDataStore(createRedisDataPort(client), { prefix?, indexes?, softDelete? })` |
| **Postgres** | `@smithy-hono/adapter-postgres` + `pg` | `createPostgresDataStore(createPgDataPort(client, table?), { table?, indexes?, softDelete? })` + DDL via `pgCreateTableSql` / `pgCreateIndexSql` |
| **Cloudflare D1** | `@smithy-hono/adapter-cf` | `createD1DataStore(createD1DataPort(db, table?), { table?, indexes?, softDelete? })` + DDL via `d1CreateTableSql` / `d1CreateIndexSql` |
| **Cloudflare KV** | `@smithy-hono/adapter-cf` | `createKvDataStore(kv, { prefix?, softDelete? })` (subset — no optimistic concurrency) |
| **AWS DynamoDB** | `@smithy-hono/adapter-aws` | `createDynamoDataStore(createDynamoDataPort(client, table?, { indexes? }), { table?, indexes?, softDelete? })` + schema via `describeDataTable(table, indexes)` |

> **Verified naming caveats.** The Redis *data* store option is `prefix`
> (`createRedisDataStore(port, { prefix, indexes })`); the Postgres data-store
> options have **no** `prefix` (use `table`); the D1 data-store options use
> `table` (not `prefix`), while the KV data store uses `prefix`. DynamoDB has no
> SQL DDL — `describeDataTable(...)` returns a schema descriptor (pk/sk + GSIs)
> you provision via your IaC. Security-pipeline stores are a *separate* set
> (`Memory*` / `Redis*` / `Kv*` / `Durable*` / `Dynamo*`) — see
> [`security.md`](./security.md#stores-per-platform).

Redis example (from
`examples/todo-api/src/server.redis.ts`
for the security-store convention; the data-store convention is identical):

```ts
import Redis from 'ioredis'
import { createRedisDataPort, createRedisDataStore, type RedisDataClientLike } from '@smithy-hono/adapter-node'

const redis = new Redis(process.env.REDIS_URL!)
const dataPort = createRedisDataPort(redis as unknown as RedisDataClientLike)
const store = createRedisDataStore<TaskData>(dataPort, { prefix: 'task:', indexes: ['status'] })
const ops = createDefaultTaskOperations(store)
```

---

## Assembling the Hono app

Minimal (no security — like crud-api):

```ts
import { Hono } from 'hono'
import { createTaskRouter } from './generated/task.gen'
import { createDefaultTaskOperations } from './generated/task.crud.gen'

const app = new Hono()
app.route('/', createTaskRouter(createDefaultTaskOperations(store)))
export default app
```

Serve it (Node):

```ts
import { serve } from '@hono/node-server'
import app from './server'
serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) })
```

The **mounting order** for a secured server is health → pipeline → routers — see
[`security.md`](./security.md#assembling-the-secured-server). Don't put the
router before the pipeline.

---

## Error handling

Generated error classes extend `Error` and carry `$statusCode` and `$fault`:

```ts
export class TaskNotFound extends Error {
  readonly $statusCode = 404
  readonly $fault = 'client' as const
  constructor(message: string) {
    super(message)
    this.name = 'TaskNotFound'
    Object.setPrototypeOf(this, TaskNotFound.prototype)
  }
}
```

The router's per-handler `catch` serializes them — verified against
`task.gen.ts`:

```ts
if (e instanceof ValidationError)
  return c.json({ code: 'ValidationError', message: e.message }, e.$statusCode)
if (e instanceof TaskNotFound)
  return c.json({ code: 'TaskNotFound', message: e.message }, e.$statusCode)
return c.json({ code: 'InternalServerError', message: 'Internal server error' }, 500)
```

So:

- **Modeled error** → `{ code: '<ErrorName>', message: '<e.message>' }` at the
  error's `$statusCode`. Throw these from your handlers.
- **Input validation failure** (Zod) → `{ code: 'ValidationException',
  fieldErrors: [{ path, code }] }` at **400** — automatic, before your handler.
- **Anything else** → `{ code: 'InternalServerError', message: 'Internal server
  error' }` at **500** (the real message is never leaked).
- **Success codes**: `201` for create (POST), `204` (empty body) for delete,
  `200` otherwise.

The `errors.ts` runtime base brands genuinely-modeled errors
(`MODELED_ERROR_BRAND`) so the security pipeline's sanitizer only reflects
*their* messages — never accidental internal-error text.

---

## Pagination

List operations use the standard Smithy `@paginated` trait with an **opaque
cursor**. Model it as:

```smithy
@readonly
@paginated(inputToken: "nextToken", outputToken: "nextToken", items: "items", pageSize: "maxResults")
@http(method: "GET", uri: "/tasks", code: 200)
operation ListTasks { input: ListTasksInput, output: ListTasksOutput }
```

The generated input accepts `nextToken?: string` and `maxResults?: number`
(`1..100`); the output returns `items` plus an optional `nextToken`. The
`@persisted` default impl maps these onto the `DataStore.list({ limit, cursor })`
→ `Page { items, cursor }` contract automatically — the cursor is opaque, just
pass it back. Hand-written handlers do the same mapping themselves.

---

## SSE / streaming (read before you rely on it)

**`@sseStream` does NOT emit a streaming handler.** It only sets
`streaming: true` in `registry.gen.ts` (which makes the security-headers
middleware skip `Cache-Control: no-store`). The generated route still returns the
operation's output struct as a normal JSON ack. This is verified against the
codegen source (`RouteEmitter` has no SSE path; `MetadataRegistryEmitter` only
writes `streaming: true`).

A real SSE endpoint is **hand-written**, using the typed pieces from
`events.gen.ts` (produced from `@sseEvent` structs):

```ts
export interface DeadeuceEventEmitter {
  emit(channelId: string, event: DeadeuceEvent): Promise<void>
}
export class DeadeuceEventSource {        // browser client
  constructor(endpoint: string, channelId: string)
  on<T extends DeadeuceEvent['type']>(type: T, handler: (data: ...) => void): () => void
  close(): void
}
```

`events.template.ts` is a **copy-once reference** (header: `// TEMPLATE — copy to
src/routes/events.ts and customise`; excluded from the sync). Copy it, implement
the `subscribe` side of your bus, and mount it **ahead of** the generated route.
The template's core (verified verbatim):

```ts
import { streamSSE } from 'hono/streaming'
import type { DeadeuceEventEmitter, DeadeuceEvent } from '../generated/events.gen'

type EventBusWithSubscribe = DeadeuceEventEmitter & {
  subscribe(channelId: string, handler: (event: DeadeuceEvent) => Promise<void>): () => void
}

export function createEventsRouter(eventBus: EventBusWithSubscribe): Hono {
  const app = new Hono()
  app.get('/:channelId/events', async (c) => {
    const { channelId } = c.req.param()
    return streamSSE(c, async (stream) => {
      const unsubscribe = eventBus.subscribe(channelId, async (event) => {
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event.data), id: String(Date.now()) })
      })
      stream.onAbort(() => unsubscribe())
    })
  })
  return app
}
```

Mount it before the generated router so its `/:channelId/events` route wins:

```ts
app.route('/tasks', createEventsRouter(eventBus))   // hand-written SSE first
app.route('/', createTaskRouter(ops))               // generated JSON ack route second
```

---

## MCP exposure

When your model has operations (and optionally `@mcpPrompts`), codegen emits
`mcp.gen.ts`:

```ts
export const MCP_TOOLS = [
  { op: OPERATIONS.CreateTask, inputSchema: _task.CreateTaskInputSchema, outputSchema: _task.CreateTaskOutputSchema },
  // ...one per operation
]
export const MCP_PROMPTS = [
  { name: "triage-tasks", description: "...", arguments: [{ name: "focus", required: false }], template: "...{focus}." },
] as const
```

Mount an HTTP MCP endpoint with `createMcpHandler` from `@smithy-hono/mcp-core`
(it dispatches `tools/call` in-process through your Hono app's `fetch`). From
`examples/crud-api/src/createApp.ts`:

```ts
import { createMcpHandler } from '@smithy-hono/mcp-core'
import { MCP_TOOLS, MCP_PROMPTS } from '../generated/mcp.gen'

const mcp = createMcpHandler({
  tools: MCP_TOOLS,
  prompts: MCP_PROMPTS,
  app,                                   // the Hono app — satisfies FetchLike
  info: { name: 'crud-api', version: '0.1.0' },
})
app.all('/mcp', (c) => mcp(c.req.raw))
```

`createMcpHandler(config)` config fields: `tools`, `app`, `info { name, version }`,
plus optional `prompts`, `origin` (default `http://mcp.local`), `resources`, and
`auth` (OAuth 2.1 resource-server config — see todo-api's `mcpAuth.ts` and
[`security.md`](./security.md#mcp-as-an-oauth-resource-server)).

**stdio transport** (for desktop MCP clients) is a Node-only subpath. From
`examples/crud-api/src/mcp-stdio.ts`:

```ts
import { serveStdio } from '@smithy-hono/mcp-core/stdio'
import { MCP_TOOLS } from '../generated/mcp.gen'
import { createCrudApp } from './createApp'

const { app } = createCrudApp({ mcp: false })   // stdio IS the transport; no HTTP /mcp
await serveStdio({ tools: MCP_TOOLS, app, info: { name: 'crud-api', version: '0.1.0' } })
```

---

## Testing with test-kit

`@smithy-hono/test-kit` (devDependency) gives you an integration harness that
mounts the real security pipeline plus helpers. Key exports (verified):

- `createTestHarness({ operations, router, createClient, config? })` →
  `Harness` with `app`, `stores` (the `Memory*` impls), `config`, `client`
  (unauthenticated), and the methods:
  - `harness.loginAs(principalOrOptions?)` → `{ client, sessionId, csrfToken,
    principal }` (cookie + CSRF; defaults to a superuser).
  - `harness.asService({ keyId, secret, clientId?, signedHeaders?, baseUrl? })`
    → an HMAC-signing client (SH-HMAC-SHA256).
- `mountRouter({ router, createClient, principal?, operations? })` — a lighter
  unit harness (no full pipeline).
- `expectError(fn, ErrorClass)` / `expectStatus(fn, status)` / `catchError(fn)`.
- `createMcpClient(app, { path?, token? })` → `{ rpc, listTools, callTool }`
  (path defaults to `/mcp`).
- Builders: `principal({...})`, `superuser(operations)`,
  `allPermissions(operations)`, `sessionRecord({...})`, `fakeContext({...})`.

```ts
import { createTestHarness, expectStatus } from '@smithy-hono/test-kit'
import { OPERATIONS } from '../generated/registry.gen'
import { createTodoRouter } from '../generated/todo.gen'
import { createTodoClient } from '../generated/todo.client.gen'
import { todoOps } from '../src/implementation'

const harness = createTestHarness({
  operations: OPERATIONS,
  router: createTodoRouter(todoOps),
  createClient: (fetch) => createTodoClient({ fetch, baseUrl: 'http://test.local' }),
})

const { client } = await harness.loginAs()           // authed
await client.CreateTodo({ body: { title: 'x' } })

const svc = await harness.asService({ keyId: 'k1', secret: 's3cr3t' })  // S2S
```

See `examples/todo-api/test` and
`examples/secure-api/test/security-e2e.test.ts`
for worked tests.
