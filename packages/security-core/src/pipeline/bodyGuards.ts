/**
 * Pipeline phase 7 — `bodyGuards` (S4, VAL-04/05/06).
 *
 * The pre-deserialization body gate. It runs *before* the body is read (ARCH-07
 * layer 1, AUTH-11 fail-fast) and rejects requests that are too large or carry
 * the wrong content-type, so neither the Zod layer nor the handler ever sees a
 * hostile payload. Web-standard APIs only (ARCH-01): no `node:*` imports.
 *
 *   - VAL-04 body size — `Content-Length` over the resolved limit → 413, before
 *     the body is touched. The limit is per-operation (`op.constraints.maxBodyBytes`)
 *     with a global default fallback (`config.maxBodyBytes`).
 *   - VAL-06 content-type — a request carrying a body MUST declare the modeled
 *     protocol content-type (`config.protocolContentType`, restJson1 →
 *     `application/json`). Mismatch → 415. Bodyless GET/DELETE/HEAD are skipped.
 *   - VAL-05 structural limits — after the body is bounded (VAL-04), `bodyGuards`
 *     parses it and runs {@link assertWithinStructuralLimits} (max depth / array
 *     length / object keys) BEFORE the per-op Zod validator, so a pathologically
 *     nested payload under the byte cap can't exhaust the stack/heap. Limits come
 *     from `config.structuralLimits` (default {@link DEFAULT_STRUCTURAL_LIMITS}).
 *
 * Split for PIPELINE-MW-01: the cheap header-only checks (VAL-04 honest
 * `Content-Length` 413 + VAL-06 content-type 415) are exported as
 * {@link headerGuards} and mounted BEFORE the coarse per-IP rate limiter, while
 * the expensive body buffering+decode+parse+structural walk stays in
 * {@link bodyGuards} and is mounted AFTER the per-IP limiter (but before
 * authenticate/verifySignature, which need the bounded body). So a body-carrying
 * flood is 413/415'd on headers alone — or shed by the per-IP gate — before any
 * request pays the read+decode+parse cost. The body cost remains hard-bounded:
 * `readBoundedBody` caps the buffer at `maxBodyBytes`, the decode/parse are single
 * passes, and the structural walk is O(n) and depth-capped. The two stages are
 * wired in order by `pipeline/index.ts`; each is independently correct standalone.
 */

import type { MiddlewareHandler } from 'hono'
// Shared pipeline types are owned by ./index.ts; import type-only to stay out of
// that module (parallel-safety) while reusing its resolver/meta contracts.
import type { SecurityConfig } from '../config.js'
import type { PipelineOperationMeta } from './index.js'

/**
 * The validation-tier config fields `bodyGuards` reads. These are NOT yet on
 * {@link SecurityConfig}; the integrator must add them (see module report). Until
 * then the handler types its param as `SecurityConfig & ValidationConfig`.
 */
export interface ValidationConfig {
  /** Global default body-size cap in bytes (VAL-04), used when an op declares no override. */
  maxBodyBytes: number
  /** The modeled protocol content-type (VAL-06). restJson1 → `application/json`. */
  protocolContentType: string
  /**
   * Structural ceilings (VAL-05) — max nesting depth / array length / object keys.
   * Defaults to {@link DEFAULT_STRUCTURAL_LIMITS} when omitted.
   */
  structuralLimits?: StructuralLimits
}

/** `(method, path) → OperationMeta | undefined`, mirroring `pipeline/index.ts`. */
type OpResolver = (method: string, path: string) => PipelineOperationMeta | undefined

/** HTTP methods that are bodyless by convention — content-type is not enforced. */
const BODYLESS_METHODS = new Set(['GET', 'DELETE', 'HEAD'])

/**
 * Default structural ceilings (VAL-05) applied even when the model omits
 * constraints. Conservative caps that no legitimate restJson1 payload should hit;
 * the real per-shape bounds are still enforced by the generated Zod layer.
 */
export interface StructuralLimits {
  /** Maximum object/array nesting depth. */
  maxDepth: number
  /** Maximum number of elements in any single array. */
  maxArrayLength: number
  /** Maximum number of keys in any single object. */
  maxObjectKeys: number
}

export const DEFAULT_STRUCTURAL_LIMITS: StructuralLimits = {
  maxDepth: 32,
  maxArrayLength: 10_000,
  maxObjectKeys: 1_000,
}

/**
 * Structural-limit hook (VAL-05). A bounded, recursive walk of an already-parsed
 * JSON value that throws {@link StructuralLimitError} on the first breach. Apply
 * this to the parsed body *before* handing it to Zod (the validator/handler is the
 * caller). Kept separate from the middleware because the parsed value only exists
 * downstream, after the body is read.
 *
 * It does not mutate or coerce — it only asserts the shape is within bounds, so an
 * adversary cannot exhaust the stack/heap via deep nesting or huge collections
 * before per-shape constraints run.
 */
export function assertWithinStructuralLimits(
  value: unknown,
  limits: StructuralLimits = DEFAULT_STRUCTURAL_LIMITS,
  depth = 0,
): void {
  if (depth > limits.maxDepth) {
    throw new StructuralLimitError(`nesting depth exceeds ${limits.maxDepth}`)
  }
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayLength) {
      throw new StructuralLimitError(`array length ${value.length} exceeds ${limits.maxArrayLength}`)
    }
    for (const item of value) {
      assertWithinStructuralLimits(item, limits, depth + 1)
    }
  } else if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
    if (keys.length > limits.maxObjectKeys) {
      throw new StructuralLimitError(`object key count ${keys.length} exceeds ${limits.maxObjectKeys}`)
    }
    for (const key of keys) {
      assertWithinStructuralLimits((value as Record<string, unknown>)[key], limits, depth + 1)
    }
  }
  // primitives (string/number/boolean/null) are leaves — nothing to recurse into.
}

/** Thrown by {@link assertWithinStructuralLimits} when a payload breaches a bound. */
export class StructuralLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StructuralLimitError'
  }
}

/** Thrown by {@link readBoundedBody} when the streamed body exceeds the byte cap. */
export class BodyTooLargeError extends Error {
  constructor(
    readonly limit: number,
    readonly bytesRead: number,
  ) {
    super(`request body exceeds the ${limit}-byte cap (read ${bytesRead}+ bytes)`)
    this.name = 'BodyTooLargeError'
  }
}

/**
 * Read a Web `ReadableStream` request body fully into memory, aborting the moment
 * the accumulated byte count exceeds {@link limit} (VAL-04 — enforced *during*
 * read). This is the real defense the declared-`Content-Length` check cannot give:
 * the ceiling is counted from the ACTUAL stream, so a chunked / `Content-Length`-
 * absent / lying-small-`Content-Length` payload is rejected once it crosses the cap
 * instead of being buffered whole. On overflow the stream is cancelled (signalling
 * the producer to stop) and {@link BodyTooLargeError} is thrown.
 *
 * Web-standard streams only (ARCH-01): no `node:*`, no `Buffer`.
 *
 * @param body  the request body stream (`c.req.raw.body`); `null` → empty body.
 * @param limit the hard byte ceiling (per-op `maxBodyBytes` or the global default).
 * @returns the body bytes (≤ {@link limit}) as a `Uint8Array`.
 */
export async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> {
  if (body === null) return new Uint8Array(0)

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > limit) {
        await reader.cancel()
        throw new BodyTooLargeError(limit, total)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * Rebuild the in-flight `Request` around the already-bounded body bytes so that the
 * downstream JSON deserializer (`c.req.json()` / `zValidator`) and the HMAC raw-body
 * reader ({@link import('../signing/rawBody.js').readRawBody}) read the bounded
 * bytes — never the original, unbounded stream. The declared `Content-Length` is
 * dropped (it may be absent or a lie); the runtime recomputes it from the real body.
 */
function rebuildBoundedRequest(raw: Request, body: Uint8Array): Request {
  const headers = new Headers(raw.headers)
  headers.delete('content-length')
  // Hand the runtime a plain ArrayBuffer (a BufferSource) sized to the exact bytes —
  // a generic `Uint8Array<ArrayBufferLike>` / `ArrayBufferLike` is not assignable to
  // BodyInit (it admits SharedArrayBuffer).
  const buffer = new ArrayBuffer(body.byteLength)
  new Uint8Array(buffer).set(body)
  return new Request(raw.url, {
    method: raw.method,
    headers,
    body: body.byteLength > 0 ? buffer : undefined,
  })
}

/**
 * Parse a `Content-Type` header value's media type (drops parameters like
 * `; charset=utf-8` and normalizes case/whitespace). Returns `''` when absent.
 */
function mediaType(contentType: string | undefined): string {
  if (!contentType) return ''
  const semi = contentType.indexOf(';')
  const base = semi === -1 ? contentType : contentType.slice(0, semi)
  return base.trim().toLowerCase()
}

/**
 * Resolve the per-request body-size limit (per-op `maxBodyBytes` override falling
 * back to the global default) and the declared `Content-Length`. Shared by the
 * cheap header stage and the body stage so both agree on the limit.
 */
function resolveLimit(
  c: Parameters<MiddlewareHandler>[0],
  config: SecurityConfig & ValidationConfig,
  resolve: OpResolver,
  method: string,
): { limit: number; declaredLength: number | undefined; hasBody: boolean } {
  const op = resolve(method, c.req.path)
  const limit = op?.constraints.maxBodyBytes ?? config.maxBodyBytes
  const contentLength = c.req.header('content-length')
  const declaredLength = contentLength !== undefined ? Number(contentLength) : undefined
  // Treat an UNTRUSTWORTHY declared length (absent, NaN from a malformed/duplicate
  // `Content-Length: abc` / `100, 100`, or negative) as "body present, size
  // unknown" so the VAL-06 content-type check and the VAL-04 during-read cap still
  // run instead of being skipped by a `NaN > 0` === false comparison. A genuine
  // `Content-Length: 0` is the only value that marks the body absent. (VAL-04/05/06)
  const hasBody = declaredLength === undefined || !Number.isFinite(declaredLength) || declaredLength > 0
  return { limit, declaredLength, hasBody }
}

/**
 * Build the CHEAP header-only body guard (VAL-04 honest-`Content-Length` 413 +
 * VAL-06 content-type 415). It touches NO body bytes, so it can sit BEFORE the
 * coarse per-IP rate limiter (PIPELINE-MW-01): a body-carrying flood is 413/415'd
 * on headers alone, or shed by the limiter, before the expensive
 * buffer+decode+parse+structural-walk in {@link bodyGuards} runs.
 *
 * What this stage enforces (header-only):
 *   - VAL-04 fast-path — an HONEST oversize `Content-Length` → 413, before a byte
 *     is read. The dishonest cases (absent / chunked / lying-small) are caught by
 *     the during-read cap in {@link bodyGuards}.
 *   - VAL-06 — a body-carrying request MUST declare the modeled content-type → 415.
 */
export function headerGuards(
  config: SecurityConfig & ValidationConfig,
  resolve: OpResolver,
): MiddlewareHandler {
  const expectedType = mediaType(config.protocolContentType) || 'application/json'

  const handler: MiddlewareHandler = async (c, next) => {
    const method = c.req.method.toUpperCase()
    const { limit, declaredLength, hasBody } = resolveLimit(c, config, resolve, method)

    // VAL-04 fast-path — HONEST oversize Content-Length, before a single byte.
    if (declaredLength !== undefined && Number.isFinite(declaredLength) && declaredLength > limit) {
      return c.json({ code: 'PayloadTooLarge' }, 413)
    }

    if (!BODYLESS_METHODS.has(method)) {
      // VAL-06 — content-type, header-only and before any body read.
      if (hasBody && mediaType(c.req.header('content-type')) !== expectedType) {
        return c.json({ code: 'UnsupportedMediaType' }, 415)
      }
    }

    await next()
  }
  Object.defineProperty(handler, 'name', { value: 'headerGuards' })
  return handler
}

/**
 * Build the body-stage guard (VAL-04 during-read cap + VAL-05 structural bounds).
 * This is the EXPENSIVE phase — it buffers the body into memory, decodes, parses
 * and runs the recursive structural walk — so the pipeline mounts it AFTER the
 * coarse per-IP rate limiter (PIPELINE-MW-01) but BEFORE
 * `authenticate`/`verifySignature` (which need the bounded body). The cheap
 * header-only checks (413/415) live in {@link headerGuards}, mounted before the
 * limiter; this stage assumes they have already run.
 *
 *   - VAL-04 — enforce the byte ceiling DURING read. Counts the actual stream, so a
 *     chunked / Content-Length-absent / lying-small-Content-Length body that crosses
 *     the cap is rejected with 413 instead of being buffered whole. The bounded bytes
 *     replace the request body so the downstream JSON deserializer and the HMAC
 *     raw-body reader both see only the capped payload.
 *   - VAL-05 — structural bounds. Parse the (now bounded) JSON and assert
 *     depth/array/object-key ceilings BEFORE the per-op zValidator runs.
 *
 * Standalone (e.g. in tests) it still re-derives the limit and honors the same
 * bodyless-method skip, so its behavior is identical whether or not
 * {@link headerGuards} ran first.
 */
export function bodyGuards(
  config: SecurityConfig & ValidationConfig,
  resolve: OpResolver,
): MiddlewareHandler {
  const structuralLimits = config.structuralLimits ?? DEFAULT_STRUCTURAL_LIMITS

  const handler: MiddlewareHandler = async (c, next) => {
    const method = c.req.method.toUpperCase()
    const { limit, hasBody } = resolveLimit(c, config, resolve, method)

    if (!BODYLESS_METHODS.has(method)) {
      // VAL-04 — enforce the byte ceiling DURING read. Counts the actual stream,
      // so a chunked / Content-Length-absent / lying-small-Content-Length body that
      // crosses the cap is rejected with 413 instead of being buffered whole. The
      // bounded bytes replace the request body so the downstream JSON deserializer
      // and the HMAC raw-body reader both see only the capped payload.
      if (hasBody) {
        let bounded: Uint8Array
        try {
          bounded = await readBoundedBody(c.req.raw.body, limit)
        } catch (e) {
          if (e instanceof BodyTooLargeError) {
            return c.json({ code: 'PayloadTooLarge' }, 413)
          }
          throw e
        }
        c.req.bodyCache = {}
        c.req.raw = rebuildBoundedRequest(c.req.raw, bounded)

        // VAL-05 — structural bounds. Parse the (now bounded) JSON and assert
        // depth/array/object-key ceilings BEFORE the per-op zValidator runs its
        // potentially deep/recursive Zod work, so a pathologically nested payload
        // under the byte cap can't exhaust the stack/heap. Malformed JSON is left
        // for the validator to reject with its structured 400.
        if (bounded.byteLength > 0) {
          let parsed: unknown
          try {
            parsed = JSON.parse(new TextDecoder().decode(bounded))
          } catch {
            parsed = undefined // not JSON — defer to the per-op validator
          }
          if (parsed !== undefined) {
            try {
              assertWithinStructuralLimits(parsed, structuralLimits)
            } catch (e) {
              if (e instanceof StructuralLimitError) {
                return c.json({ code: 'PayloadTooLarge' }, 413)
              }
              throw e
            }
          }
        }
      }
    }

    await next()
  }
  Object.defineProperty(handler, 'name', { value: 'bodyGuards' })
  return handler
}
