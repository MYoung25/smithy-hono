# todo-api — minimal smithy-hono example

A complete end-to-end example showing how smithy-hono turns a Smithy service
model into a running Hono API.

## What's here

```
model/main.smithy            ← you write this: the service definition
smithy-build.json            ← plugin config: which service, where to output

generated/todo.gen.ts        ← plugin outputs this: Zod schemas, error classes, ops interface + router factory
generated/registry.gen.ts    ← plugin outputs this: the OPERATIONS auth/registry table
generated/permissions.gen.ts ← plugin outputs this: the declared permission scopes
generated/errors.ts          ← plugin outputs this: the SmithyError base + brand
generated/todo.client.gen.ts ← plugin outputs this: a typed HTTP client
generated/mcp.gen.ts         ← plugin outputs this: the MCP tool manifest (Plan 14)
generated/index.ts           ← plugin outputs this: barrel re-export

src/implementation.ts        ← you write this: implement the operations interface
src/server.ts                ← you write this: mount the generated router (in-memory stores)
src/server.redis.ts          ← you write this: same posture, Redis-backed stores (adapter-node)
src/index.ts                 ← you write this: start the server (npm run dev/start)
src/index.redis.ts           ← you write this: start the Redis-backed server (npm run start:redis)
src/mcpAuth.ts               ← you write this: mount /mcp behind the same security pipeline
```

## The workflow

1. **Define your API in Smithy** (`model/main.smithy`)
   - Annotate operations with `@http`, `@requiresAuth`, `@httpLabel`, etc.

2. **Run codegen** from the repo root
   ```
   ./gradlew smithyBuild
   ```
   The plugin reads the model and writes `generated/*.gen.ts`.

3. **Implement the generated interface** (`src/implementation.ts`)
   ```ts
   // The plugin generates this interface — you implement it:
   export interface TodoOperations {
     CreateTodo(input: { body: CreateTodoBody }): Promise<CreateTodoOutput>
     DeleteTodo(input: { id: string }): Promise<void>
     GetTodo(input: { id: string }): Promise<GetTodoOutput>
     ListTodos(input: { nextToken?: string }): Promise<ListTodosOutput>
   }
   ```

4. **Mount the router** (`src/server.ts`)
   ```ts
   import { createTodoRouter } from '../generated/todo.gen'
   app.route('/', createTodoRouter(todoOps))
   ```

## Running the example

The `generated/` files are pre-committed so you can run the server without
installing Gradle or regenerating.

```bash
cd examples/todo-api
npm install
# TRUST_PROXY_HEADERS=1 lets the dev box treat plaintext localhost as OK; without
# it the pipeline fails closed and rejects http:// with 400 InsecureTransport (see
# the TRUSTED-HOP BOUNDARY note in src/server.ts).
TRUST_PROXY_HEADERS=1 npm run dev
```

Then try it. The server mounts the full security pipeline (see **Auth** below), so
only `ListTodos` is reachable anonymously — `GET /todos/{id}` (needs `todos.read`),
`POST /todos` and `DELETE /todos/{id}` (need `todos.write`) return **401** with no
session/signature, **403** with the wrong permission. The create/get/delete calls
below show the request *shape*; supply a cookie session or a signed S2S request to
satisfy the gate.

```bash
# List todos — anonymous (@optionalAuth), works out of the box
curl http://localhost:3000/todos

# Create a todo — requires todos.write (401 without auth)
curl -X POST http://localhost:3000/todos \
  -H 'Content-Type: application/json' \
  -d '{"title": "Buy milk"}'

# Get by id — requires todos.read (use the id from the create response)
curl http://localhost:3000/todos/<id>

# Delete — requires todos.write
curl -X DELETE http://localhost:3000/todos/<id>
```

A Redis-backed variant (`@smithy-hono/adapter-node` over Redis for the
session / nonce / secret stores) boots from the same model with
`REDIS_URL=… npm run start:redis` (`src/index.redis.ts` → `src/server.redis.ts`).

## What the plugin generates

**Zod schemas + TypeScript types** — derived directly from the Smithy shapes:
```ts
export const TodoSchema = z.object({
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
  createdAt: z.string().datetime(),
}).strict()
export type Todo = z.infer<typeof TodoSchema>
```

**Typed error classes** — one per `@error` shape, with `$statusCode` and `$fault`:
```ts
export class TodoNotFound extends Error {
  readonly $statusCode = 404
  readonly $fault = 'client' as const
}
```

**Operations interface** — the contract your implementation must satisfy:
```ts
export interface TodoOperations {
  GetTodo(input: { id: string }): Promise<GetTodoOutput>
  // ...
}
```

**Router factory** — wires Zod validators, the authorization hook, and error
handling. The optional second arg is the per-operation middleware map (the slot
resource policies ride — see **Auth**):
```ts
export function createTodoRouter(ops: TodoOperations, middleware?: TodoMiddleware): Hono
```

## Auth

Authentication and authorization are handled by the runtime security pipeline
(`@smithy-hono/security-core`), not by a hand-written middleware:

- **Authentication** — `createSecurityPipeline(...)`'s `authenticate` phase
  resolves the caller (cookie session / OIDC, or an HMAC-signed S2S request) and
  sets the `Principal` on the context. Mount it once in front of the router (see
  `src/server.ts`).
- **Authorization** — for each `@requiresAuth(permission: "…")` operation the
  generated router emits `authorize(OPERATIONS.<Op>)`, which reads that resolved
  principal and enforces the required permission deny-by-default (401 with no
  principal, 403 when a permission is missing). No per-route middleware to write.

```ts
// src/server.ts
const app = new Hono<SecurityEnv>()
app.use('*', ...createSecurityPipeline(OPERATIONS, securityConfig))
app.route('/', createTodoRouter(todoOps))
```

Resource-level checks ("may this principal act on *this* row?") ride the
per-operation middleware slot via `requireResourcePolicy(...)` from
`@smithy-hono/security-core`.
