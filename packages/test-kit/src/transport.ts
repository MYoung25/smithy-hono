import type { Hono } from 'hono'

/**
 * The `fetch`-shaped function the GENERATED client accepts. In tests you wire it to
 * Hono's in-memory `app.request` (no network); in production it's `globalThis.fetch`.
 */
export interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>
}

/** Just the surface of a Hono app the transport needs. */
export type AppLike = Pick<Hono, 'request'>

/** The outgoing request a {@link InMemoryFetchOptions.sign} hook receives. */
export interface SignableRequest {
  method: string
  url: string
  headers: Headers
  /**
   * The request body, normalized to the exact bytes the app will receive so the
   * signature actually binds it. A string stays a string; a `URLSearchParams` is
   * serialized; a `Blob` is read to an `ArrayBuffer`; `Uint8Array`/`ArrayBuffer`
   * pass through unchanged. `undefined` when there is no body.
   */
  body?: string | ArrayBuffer | Uint8Array
}

/**
 * Normalize a fetch `BodyInit` into the exact bytes the in-memory app will consume,
 * so the sign hook hashes the SAME body the verifier later re-hashes. Previously any
 * non-string body was silently dropped to `undefined`, signing an empty body while the
 * app forwarded the real bytes → verifier hash mismatch → spurious 401.
 */
async function toSignableBody(
  body: BodyInit | null | undefined,
): Promise<string | ArrayBuffer | Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  if (body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return body
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) return await body.arrayBuffer()
  throw new Error(
    `inMemoryFetch: cannot sign a request with an unsupported body type ` +
      `(${(body as { constructor?: { name?: string } })?.constructor?.name ?? typeof body}); ` +
      `pass a string, ArrayBuffer, Uint8Array, URLSearchParams, or Blob`,
  )
}

export interface InMemoryFetchOptions {
  /** Added to every request UNLESS the client already set the header (e.g. `x-forwarded-proto`). */
  defaultHeaders?: Record<string, string>
  /** Added to every request, overriding any client-set value. */
  overrideHeaders?: Record<string, string>
  /** Runs last; returned headers are attached. Used for HMAC request signing. */
  sign?: (req: SignableRequest) => Record<string, string> | Promise<Record<string, string>>
}

/**
 * Builds a {@link FetchLike} that dispatches into a Hono app via `app.request`
 * (in-memory — no sockets), merging default/override headers and optionally signing.
 * This is the single injection point the auth helpers use to attach cookies, CSRF
 * tokens, or an HMAC signature without the generated client knowing anything about it.
 */
export function inMemoryFetch(app: AppLike, opts: InMemoryFetchOptions = {}): FetchLike {
  return async (input, init) => {
    const headers = new Headers(init?.headers)
    for (const [k, v] of Object.entries(opts.defaultHeaders ?? {})) {
      if (!headers.has(k)) headers.set(k, v)
    }
    for (const [k, v] of Object.entries(opts.overrideHeaders ?? {})) {
      headers.set(k, v)
    }
    if (opts.sign) {
      const body = await toSignableBody(init?.body)
      const signed = await opts.sign({
        method: (init?.method ?? 'GET').toUpperCase(),
        url: input,
        headers,
        body,
      })
      for (const [k, v] of Object.entries(signed)) headers.set(k, v)
    }
    return app.request(input, { ...init, headers })
  }
}
