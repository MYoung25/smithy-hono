/**
 * Public types for the MCP bridge. These are STRUCTURAL — `mcp-core` never
 * imports generated code; the generated `OPERATIONS` entries (registry.gen.ts)
 * and Zod schemas (task.gen.ts) structurally satisfy them, exactly as
 * `security-core` consumes the registry without importing it.
 */

import type { ZodType } from 'zod'

/** HTTP verbs the generated routers emit. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'

/** CRUD lifecycle verb (from `@persisted` resources), used for tool annotations. */
export type CrudVerb = 'create' | 'put' | 'read' | 'update' | 'delete' | 'list'

/**
 * The slice of a generated `OperationMeta` the bridge needs. A full
 * `OPERATIONS.<Op>` value is a structural superset of this.
 */
export interface McpOperationMeta {
  /** Operation name — becomes the MCP tool name. */
  name: string
  /** HTTP method the router registered. */
  method: HttpMethod
  /** Hono-style path, e.g. `/tasks/:id`. Path params bind from tool args. */
  path: string
  /** Read-only ops get `readOnlyHint: true`. */
  readonly?: boolean
  /** Drives idempotent/destructive hints + the synthesized description fallback. */
  crudVerb?: CrudVerb
  /** Resource name, used only for the synthesized description fallback. */
  resource?: string
  /** Human-readable description (from Smithy `@documentation`, once emitted). */
  description?: string
  /**
   * Auth schemes the op accepts (structural — `OperationMeta` already carries it).
   * An op with no schemes, or one listing `anonymous`, dispatches without a principal.
   */
  authSchemes?: { type: string }[]
  /** Permissions the op requires; the default `scopeFor` reads these as OAuth scopes. */
  requiredPermissions?: string[]
  /**
   * Identifier members of the op's resource (structural — `OperationMeta` carries it).
   * A single-member read op is what the resource layer turns into a `{scheme}://{id}`
   * URI template (§7).
   */
  identifierMembers?: string[]
}

/**
 * An MCP resource *template* (`resources/templates/list`): a `{scheme}://{id}` URI
 * pattern a client expands. Derived at runtime from a resource's single-id read op.
 */
export interface McpResourceTemplate {
  uriTemplate: string
  name: string
  description?: string
  mimeType?: string
}

/**
 * A concrete MCP resource instance (`resources/list`): one enumerated record,
 * its `uri` readable via `resources/read`.
 */
export interface McpResource {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

/**
 * One MCP tool: an operation plus the Zod schemas describing its input/output.
 * `inputSchema` is the operation's *input wrapper* schema (e.g. `{ id, body }`),
 * which is exactly the shape the bridge dispatches from and the router validates —
 * one source of truth, no drift.
 */
export interface McpTool {
  op: McpOperationMeta
  inputSchema: ZodType
  outputSchema?: ZodType
  /** Overrides `op.description` / the synthesized fallback. */
  description?: string
  /** Optional human title. */
  title?: string
}

/** The dispatch target — anything with a Web `fetch` (a Hono app satisfies this). */
export interface FetchLike {
  fetch(request: Request): Response | Promise<Response>
}

/** Advertised in the MCP `initialize` response. */
export interface McpServerInfo {
  name: string
  version: string
}

/**
 * Verified bearer-token claims the bridge reads. The injected {@link BearerVerifier}
 * produces this — mcp-core never verifies a token itself (no `jose` dep, §11.6).
 */
export interface VerifiedTokenClaims {
  sub: string
  iss?: string
  aud?: string | string[]
  exp?: number
  /** Granted OAuth scopes (already parsed from the `scope`/`scp` claim). */
  scopes: string[]
  [claim: string]: unknown
}

/**
 * How a bearer token is verified. mcp-core INJECTS this rather than importing a
 * JWT library, staying dependency-light + Workers-safe (§11.6). `verify` MUST
 * reject (throw) on bad signature / issuer / audience (RFC 8707) / expiry.
 */
export interface BearerVerifier {
  verify(token: string): Promise<VerifiedTokenClaims>
}

/**
 * Derived principal handed to the trusted in-process dispatch. Structurally a
 * subset of security-core's `Principal`, so the host can `c.set('principal', …)`
 * directly. The raw token NEVER crosses into dispatch — only this derived value.
 */
export interface McpPrincipal {
  id: string
  permissions: string[]
  claims: Record<string, unknown>
  kind: 'user'
}

/**
 * OAuth 2.1 resource-server config. When set on {@link McpHandlerConfig}, the
 * handler becomes a protected RS (§11); when omitted, it is byte-for-byte the
 * Phase-1 unauthenticated handler.
 */
export interface McpAuthConfig {
  /**
   * This resource server's identifier — the canonical absolute `/mcp` URL. A
   * token's `aud` MUST contain it (enforced inside the injected verifier, RFC
   * 8707). Also the PRM `resource` value.
   */
  resource: string
  /** AS issuer URL(s) advertised in PRM `authorization_servers`. */
  authorizationServers: string[]
  /** Injected, audience-checked verifier. */
  verifier: BearerVerifier
  /** Map an op → its required OAuth scopes. Default: `op.requiredPermissions ?? []`. */
  scopeFor?: (op: McpOperationMeta) => string[]
}

/**
 * One declared argument of an {@link McpPrompt}. `name` is the `{name}` placeholder the
 * template interpolates; `required` (default false) drives the missing-arg behavior (§12.3).
 */
export interface McpPromptArgument {
  name: string
  description?: string
  required?: boolean
}

/**
 * A manifest prompt — one `MCP_PROMPTS` entry (§12). Unlike resources, prompts are NOT
 * derived at runtime; they come pre-resolved from the generated manifest. `arguments` is
 * `readonly` because the generated `MCP_PROMPTS` is `as const` (deeply readonly).
 */
export interface McpPrompt {
  name: string
  description?: string
  arguments?: readonly McpPromptArgument[]
  /** The message template; `{argName}` placeholders are interpolated at `prompts/get`. */
  template: string
}

/** Config for {@link createMcpHandler}. */
export interface McpHandlerConfig {
  /** The tools to expose. */
  tools: McpTool[]
  /** The app to dispatch into (the same Hono app that mounts the router). */
  app: FetchLike
  /** Server identity for `initialize`. */
  info: McpServerInfo
  /**
   * Origin used to build the synthetic in-process request URL. Never leaves the
   * process; defaults to `http://mcp.local`.
   */
  origin?: string
  /**
   * Optional OAuth 2.1 resource-server auth. Omit for the Phase-1 unauthenticated
   * handler (crud-api); set it to gate `tools/call` on a verified bearer (§11).
   */
  auth?: McpAuthConfig
  /**
   * MCP resources (§7). Auto-enabled when any resource is derivable from the tools
   * (a single-id read op); set `false` to force-disable and stay tool-only.
   */
  resources?: boolean
  /**
   * MCP prompts (§12) — the generated `MCP_PROMPTS` manifest. `readonly` so the
   * `as const` manifest assigns; omit/empty for a prompt-free, Phase-1-shaped handler.
   */
  prompts?: readonly McpPrompt[]
  /**
   * Transport body-size cap in bytes (MCP-CORE-03): the handler rejects a POST whose
   * declared `Content-Length` exceeds this with `413` before buffering/parsing. Defaults
   * to 1 MiB; set `0` (or negative) to disable.
   */
  maxBodyBytes?: number
  /**
   * Transport batch-length cap (MCP-CORE-03): a JSON-RPC batch longer than this is
   * rejected with `413` before any dispatch, bounding sequential work + response growth.
   * Defaults to 50; set `0` (or negative) to disable.
   */
  maxBatchSize?: number
}
