/**
 * `createMcpHandler` — a stateless MCP server over Streamable HTTP, as a plain
 * Web fetch handler. Mount it on any route (e.g. `app.all('/mcp', c => handler(c.req.raw))`).
 *
 * Transport: the client POSTs a JSON-RPC request (or batch); we reply with a
 * single `application/json` JSON-RPC response (the non-streaming Streamable-HTTP
 * shape). Notification-only payloads get `202 Accepted`. `GET` (server-initiated
 * SSE) is not needed for a tool-only server → `405`.
 */

import type { McpHandlerConfig, VerifiedTokenClaims } from './types.js'
import {
  createContext,
  handleMessage,
  precheckBatchAuth,
  type JsonRpcRequest,
} from './protocol.js'
import { resolveBearer } from './auth.js'

const PARSE_ERROR = {
  jsonrpc: '2.0' as const,
  id: null,
  error: { code: -32700, message: 'Parse error' },
}

/** Default transport guards (MCP-CORE-03); override via `McpHandlerConfig`. */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024 // 1 MiB
const DEFAULT_MAX_BATCH_SIZE = 50

/** A `413` with a JSON-RPC `-32600 Invalid Request` body for an oversized payload. */
function payloadTooLarge(message: string): Response {
  return Response.json(
    { jsonrpc: '2.0', id: null, error: { code: -32600, message } },
    { status: 413 },
  )
}

/** Sentinel returned by {@link readBodyCapped} when the running byte total exceeds the cap. */
const TOO_LARGE = Symbol('too-large')

/**
 * Read a request body as UTF-8 text while enforcing a hard byte ceiling (MCP-CORE-03).
 * Streams the body chunk-by-chunk and bails the moment the running total exceeds
 * `maxBodyBytes` — so a Content-Length-absent (or lying) client can never make us
 * buffer more than the cap before the JSON parse. Returns {@link TOO_LARGE} on overflow.
 */
async function readBodyCapped(
  request: Request,
  maxBodyBytes: number,
): Promise<string | typeof TOO_LARGE> {
  const stream = request.body
  // No stream to walk (e.g. a synthetic Request without a body) — fall back to the
  // buffered read, still bounded afterwards by the length check below.
  if (!stream) {
    const text = await request.text()
    // TextEncoder length is the byte length; guard the fallback path too.
    if (new TextEncoder().encode(text).byteLength > maxBodyBytes) return TOO_LARGE
    return text
  }
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBodyBytes) {
        await reader.cancel().catch(() => {})
        return TOO_LARGE
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.byteLength
  }
  return new TextDecoder().decode(merged)
}

export function createMcpHandler(
  config: McpHandlerConfig,
): (request: Request) => Promise<Response> {
  const ctx = createContext(config)
  // O(1) transport guards so the safe default ships in the package, not per-deployer
  // (MCP-CORE-03). Both run before any dispatch; `0`/negative disables a cap.
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const maxBatchSize = config.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE

  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { allow: 'POST' },
      })
    }

    // Body-size cap before parse: reject an oversized payload up front (when the client
    // declares Content-Length) so we never buffer/parse it.
    if (maxBodyBytes > 0) {
      const declared = Number(request.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > maxBodyBytes) {
        return payloadTooLarge('Payload Too Large')
      }
    }

    let payload: unknown
    if (maxBodyBytes > 0) {
      // Streaming backstop (MCP-CORE-03): the Content-Length check above is only a fast
      // path — a client can omit or lie about the header. Count bytes as we read so a
      // header-less oversized body is rejected before it is fully buffered/parsed.
      let text: string | typeof TOO_LARGE
      try {
        text = await readBodyCapped(request, maxBodyBytes)
      } catch {
        return Response.json(PARSE_ERROR)
      }
      if (text === TOO_LARGE) return payloadTooLarge('Payload Too Large')
      try {
        payload = JSON.parse(text)
      } catch {
        return Response.json(PARSE_ERROR)
      }
    } else {
      try {
        payload = await request.json()
      } catch {
        return Response.json(PARSE_ERROR)
      }
    }

    const batch = Array.isArray(payload)
    // Batch-length cap: bound the sequential dispatch count + responses growth before
    // entering the loop.
    if (Array.isArray(payload) && maxBatchSize > 0 && payload.length > maxBatchSize) {
      return payloadTooLarge(`batch exceeds the maximum of ${maxBatchSize} messages`)
    }
    const messages = (batch ? payload : [payload]) as JsonRpcRequest[]

    // When protected, resolve the bearer ONCE up front (the handler can't know which
    // method a POST carries until parsed): public methods tolerate a missing token,
    // `tools/call` enforces it. resolveBearer never throws.
    let claims: VerifiedTokenClaims | undefined
    if (config.auth) {
      const resolved = await resolveBearer(request, config.auth)
      if ('claims' in resolved) claims = resolved.claims
    }

    // Gate the WHOLE batch before dispatching anything (MCP-CORE-02): if any message
    // would fail the bearer/scope gate under the (constant) resolved claims, surface
    // that HTTP challenge now so no earlier — possibly mutating — message ever runs.
    if (config.auth) {
      const gate = precheckBatchAuth(messages, ctx, claims)
      if (gate) return gate.http
    }

    const responses = []
    for (const message of messages) {
      const response = await handleMessage(message, ctx, claims)
      // A failed bearer/scope gate short-circuits the whole POST with its HTTP
      // challenge — the transport (not one sub-call) is unauthenticated (§11.2).
      if (response && 'http' in response) return response.http
      if (response) responses.push(response)
    }

    // Only notifications/responses → nothing to return.
    if (responses.length === 0) return new Response(null, { status: 202 })

    return Response.json(batch ? responses : responses[0])
  }
}
