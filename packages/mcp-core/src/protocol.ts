/**
 * Minimal MCP protocol over JSON-RPC 2.0 — the methods a tool-only server needs:
 * `initialize`, `tools/list`, `tools/call`, `ping`, and the `notifications/*` it
 * must accept silently. Stateless: no session/cursor handling (tool lists are
 * small). Deliberately hand-rolled over Web standards rather than pulling in the
 * MCP SDK's Node `req`/`res` Streamable-HTTP transport (ARCH-01).
 */

import type {
  FetchLike,
  McpAuthConfig,
  McpHandlerConfig,
  McpOperationMeta,
  McpPrompt,
  McpServerInfo,
  McpTool,
  VerifiedTokenClaims,
} from './types.js'
import { callOperation, McpDispatchError } from './dispatch.js'
import {
  challenge401,
  challenge403,
  forbiddenScheme,
  isAnonymous,
  isBearerEligible,
  principalFromClaims,
  requiredScopes,
} from './auth.js'
import { buildToolDescriptor, type McpToolDescriptor } from './tools.js'
import {
  deriveResources,
  listResources,
  parseResourceUri,
  readResource,
  resourceTemplates,
  type ResourceDef,
} from './resources.js'
import { findPrompt, listPrompts, McpPromptError, renderPrompt } from './prompts.js'

/** Latest spec revision we advertise when a client sends none / an unsupported one. */
const DEFAULT_PROTOCOL_VERSION = '2025-06-18'

/**
 * The spec revisions this server speaks, newest first. `initialize` negotiates against
 * this allow-list rather than echoing the client's requested version verbatim
 * (MCP-CORE-06): an unsupported/arbitrary string gets {@link DEFAULT_PROTOCOL_VERSION}
 * (our preferred revision) so the client can decide whether to proceed or disconnect,
 * and the negotiated value is always one of these known-safe constants.
 */
const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface McpContext {
  tools: Map<string, McpTool>
  descriptors: McpToolDescriptor[]
  app: FetchLike
  info: McpServerInfo
  origin?: string
  /** OAuth RS config, present only when the handler is auth-protected (§11). */
  auth?: McpAuthConfig
  /** Resource defs derived from the tools (§7); empty when none are derivable. */
  resources: ResourceDef[]
  /** Prompts from the generated manifest (§12); empty when none are authored. */
  prompts: readonly McpPrompt[]
}

/**
 * A tagged HTTP short-circuit (a 401/403 challenge) a per-message handler can
 * return instead of a JSON-RPC response. The transport returns this `Response`
 * directly — an OAuth challenge is an HTTP-level signal, not a JSON-RPC body (§11.2).
 */
export interface McpHttpChallenge {
  http: Response
}

/**
 * Build the transport-agnostic {@link McpContext} a transport hands to
 * {@link handleMessage}. Shared by every transport (the Streamable-HTTP handler
 * and the stdio server) so the tool map / descriptors are constructed one way.
 * Web-standard-only — no node imports (ARCH-01).
 */
export function createContext(config: McpHandlerConfig): McpContext {
  return {
    tools: new Map<string, McpTool>(config.tools.map((t) => [t.op.name, t])),
    descriptors: config.tools.map(buildToolDescriptor),
    app: config.app,
    info: config.info,
    origin: config.origin,
    auth: config.auth,
    // Resources are auto-enabled from the tools; `resources: false` forces tool-only.
    resources: config.resources === false ? [] : deriveResources(config.tools),
    // Prompts come pre-resolved from the manifest; empty when none authored.
    prompts: config.prompts ?? [],
  }
}

const ok = (id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id: id ?? null,
  result,
})

const fail = (
  id: JsonRpcRequest['id'],
  code: number,
  message: string,
): JsonRpcResponse => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

/** True for a JSON-RPC notification (no `id`) — these get no response. */
const isNotification = (m: JsonRpcRequest): boolean => m.id === undefined

/**
 * Handle one JSON-RPC message. Returns the response, `null` for notifications (and
 * malformed messages, which can't be answered), or — only when `ctx.auth` is set and
 * a protected `tools/call` fails the bearer/scope gate — an {@link McpHttpChallenge}
 * the transport surfaces as a raw 401/403 (§11.2). `claims` are the eagerly-resolved
 * verified token claims, or `undefined` when no/invalid token was presented.
 */
export async function handleMessage(
  message: JsonRpcRequest,
  ctx: McpContext,
  claims?: VerifiedTokenClaims,
): Promise<JsonRpcResponse | null | McpHttpChallenge> {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return null
  }

  switch (message.method) {
    case 'initialize': {
      const requested = message.params?.protocolVersion
      // Advertise `resources` only when at least one is derivable, so a tool-only
      // service's capabilities are byte-for-byte the Phase-1 shape.
      const capabilities: Record<string, unknown> = { tools: { listChanged: false } }
      if (ctx.resources.length > 0) capabilities.resources = { listChanged: false }
      // Likewise advertise `prompts` only when at least one is authored (§12.5).
      if (ctx.prompts.length > 0) capabilities.prompts = { listChanged: false }
      // Negotiate against the supported set: honor the client's version only when we
      // speak it, else answer with our preferred revision (MCP-CORE-06).
      const protocolVersion =
        typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : DEFAULT_PROTOCOL_VERSION
      return ok(message.id, {
        protocolVersion,
        capabilities,
        serverInfo: ctx.info,
      })
    }

    case 'ping':
      return ok(message.id, {})

    case 'tools/list':
      return ok(message.id, { tools: ctx.descriptors })

    case 'tools/call': {
      const name = message.params?.name as string | undefined
      const args = message.params?.arguments as Record<string, unknown> | undefined
      if (!name) return fail(message.id, -32602, 'tools/call requires a tool name')
      const tool = ctx.tools.get(name)
      if (!tool) return fail(message.id, -32602, `unknown tool: ${name}`)

      // OAuth gate: a non-anonymous op needs a verified token carrying every
      // required scope. A missing token → 401, a valid-but-underscoped token → 403;
      // both are HTTP challenges (the whole POST short-circuits), not JSON-RPC errors.
      const gate = authGate(ctx, tool.op, claims)
      if (gate) return gate
      // Carry a derived principal only for an authed, non-anonymous op; anonymous
      // ops (and the no-`auth` case) dispatch with none — exactly as Phase 1.
      const principal =
        ctx.auth && claims && !isAnonymous(tool.op) ? principalFromClaims(claims) : undefined

      try {
        const { ok: isOk, body } = await callOperation(ctx.app, tool.op, args, ctx.origin, principal)
        const text = typeof body === 'string' ? body : JSON.stringify(body ?? null)
        if (!isOk) {
          // Modeled/HTTP errors are reported as a tool error result, not a
          // protocol error — the LLM sees the message and can recover.
          return ok(message.id, { content: [{ type: 'text', text }], isError: true })
        }
        return ok(message.id, {
          content: [{ type: 'text', text }],
          structuredContent: body && typeof body === 'object' ? body : undefined,
        })
      } catch (e) {
        const text = e instanceof McpDispatchError ? e.message : 'tool dispatch failed'
        return ok(message.id, { content: [{ type: 'text', text }], isError: true })
      }
    }

    case 'resources/templates/list':
      // Public: a template is pure metadata, no dispatch (so no auth gate).
      return ok(message.id, { resourceTemplates: resourceTemplates(ctx.resources) })

    case 'resources/list': {
      // Each def's list op is dispatched, so apply the SAME gate as tools/call per
      // list op: if ANY listed resource's list op needs auth we can't satisfy, return
      // the challenge (consistent with tools/call). crud-api's list is anonymous, so
      // the common path needs no token.
      for (const def of ctx.resources) {
        if (!def.listOp) continue
        const gate = authGate(ctx, def.listOp, claims)
        if (gate) return gate
      }
      const principalFor = (op: McpOperationMeta) =>
        ctx.auth && claims && !isAnonymous(op) ? principalFromClaims(claims) : undefined
      const { resources, nextCursor } = await listResources(
        ctx.app,
        ctx.resources,
        ctx.origin,
        principalFor,
      )
      return ok(message.id, nextCursor === undefined ? { resources } : { resources, nextCursor })
    }

    case 'resources/read': {
      const uri = message.params?.uri as string | undefined
      if (!uri) return fail(message.id, -32602, 'resources/read requires a uri')
      const match = parseResourceUri(uri, ctx.resources)
      if (!match) return fail(message.id, -32602, `unknown resource uri: ${uri}`)
      const { def, id } = match

      // Same bearer/scope gate as tools/call, against the read op (§11.2).
      const gate = authGate(ctx, def.readOp, claims)
      if (gate) return gate
      const principal =
        ctx.auth && claims && !isAnonymous(def.readOp) ? principalFromClaims(claims) : undefined

      const result = await readResource(ctx.app, def, id, ctx.origin, principal)
      if ('notFound' in result) return fail(message.id, -32002, `resource not found: ${uri}`)
      return ok(message.id, { contents: result.contents })
    }

    case 'prompts/list':
      // Public: a prompt descriptor is pure metadata, no dispatch (so NO auth gate, §12.3).
      return ok(message.id, { prompts: listPrompts(ctx.prompts) })

    case 'prompts/get': {
      // Also public — `prompts/get` only string-substitutes a template; it touches no
      // operation/store/principal, so there is nothing to authorize (§12.3). No gate.
      const name = message.params?.name as string | undefined
      if (!name) return fail(message.id, -32602, 'prompts/get requires a prompt name')
      const prompt = findPrompt(ctx.prompts, name)
      if (!prompt) return fail(message.id, -32602, `unknown prompt: ${name}`)
      try {
        const args = message.params?.arguments as Record<string, unknown> | undefined
        return ok(message.id, renderPrompt(prompt, args))
      } catch (e) {
        // A missing REQUIRED arg → Invalid params; any other error is a real bug.
        if (e instanceof McpPromptError) return fail(message.id, -32602, e.message)
        throw e
      }
    }

    default:
      // Accept lifecycle notifications silently; reject unknown requests.
      if (message.method.startsWith('notifications/') || isNotification(message)) return null
      return fail(message.id, -32601, `method not found: ${message.method}`)
  }
}

/**
 * The shared OAuth gate (the exact `tools/call` logic): for a protected op, a missing
 * token → 401, a valid-but-underscoped token → 403, both as HTTP challenges. Returns
 * the challenge to short-circuit, or `undefined` when the op may proceed.
 */
/**
 * Pre-scan a parsed batch and return the FIRST auth challenge any of its messages would
 * raise, BEFORE any message is dispatched (MCP-CORE-02). Because `claims` are resolved
 * once and constant for the whole POST, the gate outcome is knowable without executing
 * anything — so if a later member would 401/403, we surface that challenge up front and
 * no earlier (possibly mutating) member ever runs. Returns `undefined` when no message
 * fails the gate (the loop then dispatches normally). Cheap: no dispatch, only the same
 * gate the per-message handler applies.
 */
export function precheckBatchAuth(
  messages: JsonRpcRequest[],
  ctx: McpContext,
  claims: VerifiedTokenClaims | undefined,
): McpHttpChallenge | undefined {
  if (!ctx.auth) return undefined
  for (const message of messages) {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') continue
    if (message.method === 'tools/call') {
      const name = message.params?.name as string | undefined
      const tool = name ? ctx.tools.get(name) : undefined
      if (!tool) continue // unknown/missing tool → a JSON-RPC error, not an auth gate
      const gate = authGate(ctx, tool.op, claims)
      if (gate) return gate
    } else if (message.method === 'resources/list') {
      for (const def of ctx.resources) {
        if (!def.listOp) continue
        const gate = authGate(ctx, def.listOp, claims)
        if (gate) return gate
      }
    } else if (message.method === 'resources/read') {
      const uri = message.params?.uri as string | undefined
      const match = uri ? parseResourceUri(uri, ctx.resources) : undefined
      if (!match) continue // unknown uri → a JSON-RPC error, not an auth gate
      const gate = authGate(ctx, match.def.readOp, claims)
      if (gate) return gate
    }
  }
  return undefined
}

function authGate(
  ctx: McpContext,
  op: McpOperationMeta,
  claims: VerifiedTokenClaims | undefined,
): McpHttpChallenge | undefined {
  if (!ctx.auth || isAnonymous(op)) return undefined
  // A bearer token can NOT substitute for a non-OAuth scheme (e.g. HMAC `@sigv4Hmac`
  // S2S): hard 403, never a derived principal — accepting one would downgrade the
  // signature/replay-protected scheme to "any scoped token" (MCP-CORE-01).
  if (!isBearerEligible(op)) return { http: forbiddenScheme() }
  const need = requiredScopes(op, ctx.auth)
  // Fail closed: a scheme-protected op that resolved to ZERO required scopes is a
  // misconfiguration — treat "no scope declared" as un-satisfiable rather than "any
  // verifying token passes" (MCP-CORE-05).
  if (need.length === 0) return { http: forbiddenScheme() }
  if (!claims) return { http: challenge401(ctx.auth, need.join(' ')) }
  if (!need.every((s) => claims.scopes.includes(s))) return { http: challenge403(need.join(' ')) }
  return undefined
}
