/**
 * MCP **stdio transport** — the ONE deliberately Node-only entry point of this
 * package. A local agent launches the server as a subprocess and speaks MCP over
 * the child's stdin/stdout; everything else (the barrel `.` export, the
 * Streamable-HTTP handler, the protocol core) stays Web-standard so it bundles
 * for Workers (ARCH-01). It is reached only via the `./stdio` subpath, never the
 * main `.` export, and the node usage is confined to this file.
 *
 * Framing (MCP spec): newline-delimited JSON — each JSON-RPC message is one line
 * on stdin (no embedded newlines); responses are newline-delimited JSON on
 * stdout; notifications produce no stdout; anything else (logs) goes to stderr.
 * It reuses the same {@link createContext} + {@link handleMessage} core as the
 * HTTP transport, so the two share one source of truth.
 */

import process from 'node:process'
import type { McpHandlerConfig } from './types.js'
import { createContext, handleMessage, type JsonRpcRequest } from './protocol.js'

/** Mirror of handler.ts's PARSE_ERROR — a JSON-RPC parse error for a bad line. */
const PARSE_ERROR = {
  jsonrpc: '2.0' as const,
  id: null,
  error: { code: -32700, message: 'Parse error' },
}

/**
 * Split a stream of string/byte chunks into complete newline-delimited lines,
 * carrying a partial line across chunk boundaries. Pure and node-free so the
 * line framing is unit-testable without driving real streams: feed it chunks,
 * it yields whole lines (the trailing `\n` stripped); `flush()` returns any
 * leftover (an unterminated final line).
 */
export interface LineBufferOptions {
  /**
   * Maximum length (chars) of a single unterminated line before it is discarded as an
   * OOM guard. `0`/unset (default) = unbounded, preserving the original behavior.
   */
  maxLineBytes?: number
  /** Invoked once per over-long line that is discarded (e.g. to emit a parse error). */
  onOverflow?: () => void
}

export function createLineBuffer(opts: LineBufferOptions = {}): {
  push: (chunk: string | Uint8Array) => string[]
  flush: () => string[]
} {
  const decoder = new TextDecoder()
  const maxLineBytes = opts.maxLineBytes ?? 0
  let buffer = ''
  // True while dropping the tail of an over-long line up to its terminating newline.
  let discarding = false
  return {
    push(chunk) {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      const lines: string[] = []
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        // A newline ends the current line: if we were discarding an over-long one, this
        // closes it — resume normal framing on the remainder without emitting the junk.
        if (discarding) discarding = false
        else lines.push(line)
        nl = buffer.indexOf('\n')
      }
      // No newline left but the buffer already exceeds the cap → it can only be the start
      // of an over-long line. Drop what we have, flag that the rest (until the next
      // newline) must also be dropped, and surface a single overflow signal.
      if (maxLineBytes > 0 && buffer.length > maxLineBytes) {
        buffer = ''
        if (!discarding) {
          discarding = true
          opts.onOverflow?.()
        }
      }
      return lines
    },
    flush() {
      const rest = buffer
      buffer = ''
      // A trailing (unterminated) over-long line is dropped, not emitted.
      if (discarding) {
        discarding = false
        return []
      }
      return rest.length > 0 ? [rest] : []
    },
  }
}

/** Options for {@link serveStdio} — defaulted to real stdin/stdout, overridable in tests. */
export interface StdioOptions {
  /** Source of incoming chunks. Defaults to `process.stdin`. */
  input?: AsyncIterable<string | Uint8Array>
  /** Sink for outgoing response lines (already `\n`-terminated). Defaults to `process.stdout`. */
  output?: (line: string) => void
  /**
   * OOM guard: maximum length of a single unterminated line. When a line grows past this
   * without a newline, its bytes are discarded and a JSON-RPC parse error is emitted
   * instead of buffering unbounded. Unset (default) = unbounded, preserving prior behavior.
   */
  maxLineBytes?: number
}

/**
 * Serve MCP over stdio. Reads newline-delimited JSON-RPC requests from `input`,
 * dispatches each through the shared protocol core, and writes each non-null
 * response as a `\n`-terminated JSON line via `output`. Resolves when `input`
 * ends (the parent closed our stdin).
 */
export async function serveStdio(config: McpHandlerConfig, io: StdioOptions = {}): Promise<void> {
  const ctx = createContext(config)
  const input = io.input ?? process.stdin
  const output = io.output ?? ((line: string) => process.stdout.write(line))

  const buffer = createLineBuffer({
    maxLineBytes: io.maxLineBytes,
    // An over-long line is unparseable by definition — surface the same parse error the
    // malformed-JSON path uses instead of accumulating it (OOM guard).
    onOverflow: () => output(JSON.stringify(PARSE_ERROR) + '\n'),
  })

  const handleLine = async (raw: string): Promise<void> => {
    const line = raw.trim()
    if (line === '') return // blank line / keepalive — nothing to do

    let message: JsonRpcRequest
    try {
      message = JSON.parse(line) as JsonRpcRequest
    } catch {
      output(JSON.stringify(PARSE_ERROR) + '\n')
      return
    }

    const response = await handleMessage(message, ctx)
    // Notifications (and malformed messages) return null → no stdout. stdio never
    // sets `auth`, so an HTTP challenge can't occur; defend against the union anyway
    // by reporting a JSON-RPC internal error instead of leaking a Response object.
    if (!response) return
    if ('http' in response) {
      output(
        JSON.stringify({
          jsonrpc: '2.0' as const,
          id: message.id ?? null,
          error: { code: -32603, message: 'Internal error' },
        }) + '\n',
      )
      return
    }
    output(JSON.stringify(response) + '\n')
  }

  for await (const chunk of input) {
    for (const raw of buffer.push(chunk)) await handleLine(raw)
  }
  // Drain any unterminated final line (stdin closed mid-line).
  for (const raw of buffer.flush()) await handleLine(raw)
}
