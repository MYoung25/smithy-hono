# @smithy-hono/mcp-core

Expose a generated **smithy-hono** service as an **MCP** (Model Context Protocol)
server, so LLM agents can discover and call its operations as tools.

It's a thin runtime bridge: feed it the generated operation metadata
(`OPERATIONS` from `registry.gen.ts`) + the emitted Zod schemas as **tools**, plus
the Hono `app`, and mount the returned handler. Tool input/output JSON Schema is
derived from the **same Zod schemas the router validates** (via
`zod-to-json-schema`) — so the tool contract can't drift from the wire contract.

Design + rationale: [`plan/14-mcp-server.md`](../../plan/14-mcp-server.md).

## Install

```bash
npm i @smithy-hono/mcp-core
```

`zod` is a peer dependency (provide the same one your generated schemas use).

## Usage

The codegen emits a ready-made tool manifest, `mcp.gen.ts` (`MCP_TOOLS`). Pair it
with your Hono app and mount the handler:

```ts
import { Hono } from 'hono'
import { createMcpHandler } from '@smithy-hono/mcp-core'
import { createTaskRouter } from './generated/task.gen'
import { MCP_TOOLS } from './generated/mcp.gen'
import { taskOps } from './ops'

const app = new Hono()
app.route('/', createTaskRouter(taskOps))

// Mount MCP over Streamable HTTP at /mcp (same-origin, in-process dispatch).
const mcp = createMcpHandler({ tools: MCP_TOOLS, app, info: { name: 'task-api', version: '1.0.0' } })
app.all('/mcp', (c) => mcp(c.req.raw))
```

An MCP client then `initialize`s, calls `tools/list` (one tool per operation, with
JSON-Schema input/output, descriptions from `@documentation`, and
read-only/idempotent/destructive annotations), and `tools/call`s them.

### Without the generated manifest

Any object shaped like `{ op, inputSchema, outputSchema? }` works — `op` is a
structural subset of the generated `OperationMeta`, `inputSchema`/`outputSchema`
are Zod schemas:

```ts
const tools = [
  { op: OPERATIONS.CreateTask, inputSchema: CreateTaskInputSchema, outputSchema: CreateTaskOutputSchema },
]
```

## How it works

- **Tools** — each `MCP_TOOLS` entry becomes one MCP tool. `inputSchema`/
  `outputSchema` are rendered from the Zod schemas; `description` comes from the
  op (Smithy `@documentation`) with a `crudVerb`+`resource` fallback; annotations
  (`readOnlyHint`/`idempotentHint`/`destructiveHint`) derive from `OperationMeta`.
- **Dispatch** — `tools/call` builds a synthetic Web `Request` from the flat args
  (`:path` params → path, the `body` member → JSON body, the rest → query string)
  and runs it through `app.fetch`. Calling the router in-process — not the op
  directly — means Zod validation, the security pipeline, and the default CRUD
  impl all run unchanged. Modeled/HTTP errors come back as an MCP tool error
  result (`isError: true`), not a protocol error.
- **Transport** — a stateless Streamable-HTTP endpoint: the client `POST`s a
  JSON-RPC request (or batch) and gets a single `application/json` response;
  notification-only payloads get `202`. Implemented methods: `initialize`,
  `tools/list`, `tools/call`, `ping`, and the `notifications/*` it accepts
  silently.

## stdio transport

Besides the Web-standard Streamable-HTTP handler, the package ships an MCP
**stdio** transport for local agents that launch the server as a subprocess and
speak MCP over its stdin/stdout. It's the **one Node-only entry point**, reached
via the `./stdio` subpath — the main `.` export stays web-standard /
CF-bundleable:

```ts
import { serveStdio } from '@smithy-hono/mcp-core/stdio'
import { createTaskRouter } from './generated/task.gen'
import { MCP_TOOLS } from './generated/mcp.gen'
import { taskOps } from './ops'

const app = new Hono()
app.route('/', createTaskRouter(taskOps))

// Reads newline-delimited JSON-RPC from stdin, writes responses to stdout.
// Resolves when the parent closes our stdin. `tools/call` dispatches in-process
// via `app.fetch`, exactly like the HTTP handler.
await serveStdio({ tools: MCP_TOOLS, app, info: { name: 'task-api', version: '1.0.0' } })
```

`input`/`output` are injectable (`serveStdio(config, { input, output })`) for
tests; they default to `process.stdin`/`process.stdout`. This is the only file
that imports `node:*`; everything else stays Web-standard.

## Web-standard only (ARCH-01)

No `node:*` / Node-builtin imports — the bridge runs anywhere a Hono service runs
(Node, Cloudflare Workers, …). It is **not** built on the MCP TypeScript SDK's
Node `req`/`res` Streamable-HTTP transport; it's a hand-rolled web-standard
JSON-RPC handler. The SDK can be adopted later if richer features (resources,
prompts, tasks, server-initiated SSE) are needed.

## Auth (OAuth 2.1 resource server)

Pass `auth` to make `/mcp` an OAuth 2.1 resource server (MCP 2025-11-25): bearer
verification with **RFC 8707 audience** validation, per-tool scope enforcement,
RFC 9728 Protected Resource Metadata, and `401`/`403` + `WWW-Authenticate`
challenges. Token verification is an **injected `BearerVerifier`** — mcp-core ships
no JWT library and stays Workers-safe; wrap your existing OIDC/JWKS verifier.

```ts
const handler = createMcpHandler({
  tools: MCP_TOOLS, app: dispatchApp, info,
  auth: { resource: 'https://host/mcp', authorizationServers: [ISSUER], verifier },
})
app.all('/mcp', (c) => handler(c.req.raw))
app.get('/.well-known/oauth-protected-resource', () => protectedResourceMetadata(auth))
```

Discovery (`initialize`/`tools/list`) stays public; enforcement is at `tools/call`.
mcp-core verifies the token once, derives a principal, and attaches it to the
in-process dispatch **by Request identity** (`getAttachedPrincipal`) — the raw token
never crosses the boundary. The host's dispatch app reads it in an `all`-middleware
(`c.set('principal', getAttachedPrincipal(c.req.raw))`), so the generated `authorize`
hook re-checks scopes in-dispatch. Worked example: `examples/todo-api/src/mcpAuth.ts`.
Design + rationale: plan 14 §11.

## Resources

Each `@persisted` resource with a by-id read op is also exposed as an **MCP
resource** — derived at runtime from the same tool metadata, no extra config or
codegen. A `Task` resource becomes a `task://{id}` URI template:

- `resources/templates/list` → the `{scheme}://{id}` templates,
- `resources/read` `task://<id>` → dispatches the **read** op (`GetTask`) and returns
  the item JSON as `contents`,
- `resources/list` → enumerates via the **list** op (`ListTasks`), surfacing
  `nextToken` as `nextCursor`.

The `resources` capability auto-advertises when any are derivable. `resources/read`
and `resources/list` run the **same bearer/scope gate as `tools/call`**, so a
protected resource (e.g. todo-api's `Todo`, read via `GetTodo`) is served through
auth with no extra wiring. Design: plan 14 §7.

## Prompts

Prompts are **hand-authored in the Smithy model** via the `@mcpPrompts` trait (on the
service or an operation) and emitted into `mcp.gen.ts` as `MCP_PROMPTS`; pass them to
`createMcpHandler({ …, prompts: MCP_PROMPTS })`. Each becomes a `prompts/list` entry
whose `prompts/get` interpolates `{argName}` placeholders in the template into a single
`user` message. On an operation the codegen defaults the name, references the generated
tool, and derives arguments from the input shape. Prompts never dispatch an operation,
so `prompts/list`/`prompts/get` are **public** (no auth gate). The `prompts` capability
auto-advertises when any are present. Design: plan 14 §12.

## Not included (yet)

- **SDK adoption** — the official `@modelcontextprotocol/sdk` (only if server-initiated
  SSE / the Tasks primitive / subscriptions are ever needed); see plan 14 §10.

## API

- `createMcpHandler(config) => (request: Request) => Promise<Response>` — `config.auth` optional; `config.resources: false` disables resources; `config.prompts` is the `MCP_PROMPTS` manifest
- `buildToolDescriptor(tool)` — the `tools/list` descriptor for one tool
- `buildRequest(op, args, origin?)`, `callOperation(app, op, args, origin?, principal?)` — the dispatch primitives
- `attachPrincipal(req, principal)` / `getAttachedPrincipal(req)` — the by-Request-identity principal crossing
- `protectedResourceMetadata(auth)`, `resolveBearer(req, auth)`, `challenge401`/`challenge403`, `requiredScopes`, `isAnonymous`, `principalFromClaims` — the auth primitives
- `deriveResources(tools)`, `resourceTemplates(defs)`, `parseResourceUri(uri, defs)` — the resource primitives
- `listPrompts(prompts)`, `renderPrompt(prompt, args)`, `McpPromptError` — the prompt primitives
- `serveStdio(config, io?)` (from `@smithy-hono/mcp-core/stdio`) — the Node-only stdio transport
- `toJsonSchema(zodType)` — Zod → JSON Schema (as used for tool schemas)
- `handleMessage(message, ctx, claims?)`, `createContext(config)` — the building blocks for custom transports
- Types: `McpTool`, `McpOperationMeta`, `McpHandlerConfig`, `McpServerInfo`, `FetchLike`
