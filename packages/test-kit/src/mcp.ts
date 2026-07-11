import { inMemoryFetch, type AppLike } from './transport.js'

// MCP JSON-RPC envelopes are dynamically shaped; result/json/error are `any` by design.

/** Per-call options (a bearer token overrides the client default). */
export interface McpCallOptions {
  token?: string
  /** JSON-RPC id (default: an auto-incrementing number). */
  id?: number | null
}

/** The outcome of an MCP JSON-RPC call. */
export interface McpResponse {
  status: number
  res: Response
  /** The parsed JSON-RPC envelope for any status (best-effort; `undefined` if the body isn't JSON). */
  json: any
  /** `json.result`, for convenience. */
  result: any
  /** `json.error`, for convenience. */
  error: any
}

export interface McpClientOptions {
  /** The single JSON-RPC endpoint path (default `/mcp`). */
  path?: string
  /** A default bearer token attached to every call. */
  token?: string
  /** Headers merged into every request (default `{ 'x-forwarded-proto': 'https' }`). */
  defaultHeaders?: Record<string, string>
}

export interface McpClient {
  /** Low-level JSON-RPC call. */
  rpc(method: string, params?: unknown, opts?: McpCallOptions): Promise<McpResponse>
  /** `tools/list` — public discovery (no token needed). */
  listTools(opts?: McpCallOptions): Promise<McpResponse>
  /** `tools/call` for a named tool with arguments. */
  callTool(name: string, args?: Record<string, unknown>, opts?: McpCallOptions): Promise<McpResponse>
}

/**
 * Drives a generated MCP mount (the OAuth-protected `/mcp` endpoint) over Hono's
 * in-memory transport — no network. Collapses the repeated JSON-RPC `rpc()` helper
 * (envelope + bearer + forwarded-proto) every MCP test otherwise hand-rolls.
 */
export function createMcpClient(app: AppLike, opts: McpClientOptions = {}): McpClient {
  const path = opts.path ?? '/mcp'
  const fetchImpl = inMemoryFetch(app, {
    defaultHeaders: { 'x-forwarded-proto': 'https', ...opts.defaultHeaders },
  })
  let seq = 0

  async function rpc(method: string, params?: unknown, callOpts: McpCallOptions = {}): Promise<McpResponse> {
    const token = callOpts.token ?? opts.token
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    const id = callOpts.id === undefined ? ++seq : callOpts.id
    const res = await fetchImpl(path, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    })
    // Best-effort parse the body for ANY status: a non-200 (e.g. 401 with a
    // `{code:'Unauthorized'}` envelope) still carries a JSON body a leak-check
    // assertion needs to see, so don't blindly drop it. Falls back to undefined
    // for a non-JSON body.
    let json: any
    try {
      json = await res.clone().json()
    } catch {
      json = undefined
    }
    return { status: res.status, res, json, result: json?.result, error: json?.error }
  }

  return {
    rpc,
    listTools: (callOpts) => rpc('tools/list', undefined, callOpts),
    callTool: (name, args, callOpts) => rpc('tools/call', { name, arguments: args ?? {} }, callOpts),
  }
}
