/**
 * In-process dispatch: turn a tool call (flat args matching the operation's input
 * wrapper schema) into a synthetic Web `Request`, run it through the Hono `app`,
 * and read the result. Going through `app.fetch` (not calling the op directly)
 * re-runs Zod validation, the full security pipeline, and the CRUD default impl —
 * no duplicated logic, no network hop.
 *
 * Binding mirrors the generated router (see task.gen.ts):
 *   - `:param` tokens in the path  ← the same-named top-level arg
 *   - the `body` member            ← the JSON request body (POST/PUT/PATCH)
 *   - every other top-level member ← a query-string param
 * The `body` member name is the codegen convention for the request payload.
 */

import type { FetchLike, McpOperationMeta } from './types.js'

const PARAM = /:([A-Za-z0-9_]+)/g

/**
 * The principal-crossing channel (§11.3). Keyed by the synthetic `Request` object's
 * identity, NOT by any serializable value — only mcp-core, which constructs the
 * Request, can attach a principal, and the value can't be forged or replayed from
 * outside. The host's dispatch app reads it back via {@link getAttachedPrincipal} in
 * an `all`-slot middleware and does `c.set('principal', …)`. This is strictly cleaner
 * than a nonce/header scheme: nothing spoofable ever touches the wire.
 */
const principalByRequest = new WeakMap<Request, unknown>()

/** Stash the derived principal for an in-process dispatch (called by mcp-core only). */
export function attachPrincipal(request: Request, principal: unknown): void {
  principalByRequest.set(request, principal)
}

/** Read the principal mcp-core attached, or `undefined` for an anonymous/external request. */
export function getAttachedPrincipal(request: Request): unknown | undefined {
  return principalByRequest.get(request)
}

/** Thrown when a tool call can't be turned into a request (e.g. missing path id). */
export class McpDispatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpDispatchError'
  }
}

const hasBody = (method: string): boolean =>
  method === 'POST' || method === 'PUT' || method === 'PATCH'

export function buildRequest(
  op: McpOperationMeta,
  args: Record<string, unknown> | undefined,
  origin = 'http://mcp.local',
): Request {
  const a = args ?? {}
  const pathParams = new Set<string>()

  const path = op.path.replace(PARAM, (_m, name: string) => {
    pathParams.add(name)
    const v = a[name]
    if (v === undefined || v === null)
      throw new McpDispatchError(`missing path parameter '${name}' for tool '${op.name}'`)
    // A path label must be a scalar id. An array or object/map can't be faithfully
    // placed in a `:param` slot, so refuse LOUDLY (MCP-CORE-07) instead of shipping a
    // lossy `'1,2'` / `'[object Object]'` — mirroring the query-loop guard below.
    if (Array.isArray(v) || (typeof v === 'object' && v !== null)) {
      throw new McpDispatchError(
        `path parameter '${name}' must be a scalar for tool '${op.name}'`,
      )
    }
    return encodeURIComponent(String(v))
  })

  const query = new URLSearchParams()
  let body: string | undefined
  for (const [k, v] of Object.entries(a)) {
    if (pathParams.has(k)) continue
    if (k === 'body' && hasBody(op.method)) {
      body = JSON.stringify(v)
      continue
    }
    if (v === undefined || v === null) continue
    // Encode each member per its HTTP binding instead of a blanket lossy `String(v)`
    // (MCP-CORE-07). A list member → one query entry per element (Smithy's multi-value
    // `@httpQuery` convention), not a comma-joined `set`. A plain object/map member
    // (e.g. `@httpQueryParams`/`@httpPrefixHeaders`) can't be faithfully encoded here
    // without per-member binding metadata, so refuse LOUDLY rather than silently ship
    // `[object Object]` and have it pass the router's permissive record validators.
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item === undefined || item === null) continue
        query.append(k, String(item))
      }
      continue
    }
    if (typeof v === 'object') {
      throw new McpDispatchError(
        `member '${k}' is an object/map binding that in-process dispatch cannot faithfully encode for tool '${op.name}'`,
      )
    }
    query.set(k, String(v))
  }

  const qs = query.toString()
  const url = `${origin}${path}${qs ? `?${qs}` : ''}`
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'

  return new Request(url, { method: op.method, headers, body })
}

export interface DispatchResult {
  status: number
  ok: boolean
  /** Parsed JSON body, the raw text if not JSON, or undefined for an empty body. */
  body: unknown
}

export async function callOperation(
  app: FetchLike,
  op: McpOperationMeta,
  args: Record<string, unknown> | undefined,
  origin?: string,
  principal?: unknown,
): Promise<DispatchResult> {
  const req = buildRequest(op, args, origin)
  // Carry the derived principal across the trust boundary by Request identity — the
  // host reads it via getAttachedPrincipal(c.req.raw). Anonymous calls pass none.
  if (principal !== undefined) attachPrincipal(req, principal)
  const res = await app.fetch(req)
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    parsed = text
  }
  return { status: res.status, ok: res.ok, body: parsed }
}
