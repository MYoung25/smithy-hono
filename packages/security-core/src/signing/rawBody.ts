/**
 * ARCH-08 / SIGN-07 — raw request body access for the HMAC signature verifier.
 *
 * Phase S6 (`verifySignature`) must hash the *exact bytes* the client signed
 * (`crypto.subtle.digest('SHA-256', raw)`) and compare against the canonical
 * request — **before** the Zod/JSON deserializer parses the same body. The hard
 * constraint: a Web-standard `Request` body is a one-shot stream, so a naive
 * `await c.req.raw.text()` here would consume it and the downstream
 * `c.req.json()` would throw "body already used". {@link readRawBody} reads the
 * bytes in a way that leaves a subsequent `c.req.json()` working.
 *
 * ## Chosen mechanism (hono@4.12.25) — `c.req.arrayBuffer()`
 *
 * Hono caches body reads on `HonoRequest.bodyCache` and cross-derives between
 * representations from whichever key was filled first. From the installed source
 * (`node_modules/hono/dist/request.js`, the private `#cachedBody(key)`):
 *
 * ```js
 * #cachedBody = (key) => {
 *   const { bodyCache, raw } = this;
 *   const cachedBody = bodyCache[key];
 *   if (cachedBody) return cachedBody;            // same key → same promise (idempotent)
 *   const anyCachedKey = Object.keys(bodyCache)[0];
 *   if (anyCachedKey) {                           // different key already read →
 *     return bodyCache[anyCachedKey].then((body) => {
 *       if (anyCachedKey === 'json') body = JSON.stringify(body);
 *       return new Response(body)[key]();         // re-derive, do NOT re-read raw
 *     });
 *   }
 *   return bodyCache[key] = raw[key]();           // first read: consume raw once, cache it
 * };
 * json()        { return this.#cachedBody('text').then(JSON.parse); }
 * arrayBuffer() { return this.#cachedBody('arrayBuffer'); }
 * ```
 *
 * Therefore, calling `c.req.arrayBuffer()` first:
 *   1. fills `bodyCache.arrayBuffer` by consuming `raw` exactly once, and
 *   2. a later `c.req.json()` → `#cachedBody('text')` sees `arrayBuffer` is the
 *      already-cached key and re-derives text via `new Response(arrayBuffer).text()`
 *      — it never touches the (now-drained) `raw` stream again.
 *
 * This is why we prefer `c.req.arrayBuffer()` over manually teeing
 * `c.req.raw.clone().arrayBuffer()`: the clone path would (a) require the clone to
 * happen before *anything* reads the body and (b) leave a second un-drained stream
 * Hono doesn't know about. Going through Hono's own cache is the supported,
 * tee-free path and is what the verifier hashes. The empirical proof (raw read,
 * then json() succeeds, digest byte-exact) lives in `rawBody.test.ts`.
 *
 * `crypto.subtle.digest` accepts a `BufferSource`, so returning the raw
 * `ArrayBuffer` is the cleanest feed — no copy, no `Uint8Array` wrapper. The
 * caller hashes it directly: `await crypto.subtle.digest('SHA-256', raw)`.
 *
 * ## VAL-04 buffering bound
 *
 * Reading the full body into memory is bounded and safe **because** the pipeline
 * runs `bodyGuards` (phase 7, VAL-04) before signature verification (phase 10).
 * `bodyGuards` does not merely trust the declared `Content-Length`: for any
 * body-bearing request it reads the stream through `readBoundedBody`, counting the
 * ACTUAL bytes and aborting with 413 the moment they cross `config.maxBodyBytes`
 * (per-op override honored), then replaces `c.req.raw` with the bounded bytes. So a
 * chunked / `Content-Length`-absent / lying-small-`Content-Length` request is capped
 * during read, and by the time `readRawBody` runs `c.req.arrayBuffer()` it reads
 * only that already-bounded body — there is no unbounded buffering risk introduced
 * by hashing the whole body. See `src/pipeline/bodyGuards.ts`.
 *
 * NOTE: this guarantee depends on `bodyGuards` running before `readRawBody` in the
 * pipeline. Calling `readRawBody` on a request that did NOT pass through
 * `bodyGuards` re-introduces the unbounded read — keep the phase ordering intact.
 *
 * ## Per-runtime behavior (ARCH-08 cross-runtime concern)
 *
 * | Runtime | Status | Notes |
 * |---------|--------|-------|
 * | **Node** (`@hono/node-server`) | **PROVEN here** | `rawBody.test.ts` (vitest) reads raw, digests, then `c.req.json()` — both succeed, digest byte-exact. |
 * | **Workers** (Cloudflare / miniflare) | Expected-works | Same Web-standard `Request` and the *same* `HonoRequest.bodyCache` code path; nothing runtime-specific. No tee, no `node:*`. Same `crypto.subtle`. |
 * | **Lambda** (`hono/aws-lambda`) | **VERIFIED** | The adapter decodes API Gateway's (possibly `isBase64Encoded`) payload and builds a standard `Request` whose body is the decoded bytes; `arrayBuffer()` then yields those decoded bytes — i.e. the same bytes the client signed. This base64-decode path is now confirmed against the signed bytes by `packages/adapter-aws/src/lambdaRawBody.real.test.ts`. |
 *
 * Web-standard only (ARCH-01): `c.req.arrayBuffer()` / `crypto.subtle` in the
 * caller. No `node:*`, no `Buffer`.
 *
 * @see plan/security/11-runtime-spike-adapters.md (Part A — this spike)
 * @see plan/security/07-request-signing-hmac.md (SIGN-07, raw-body access)
 * @see src/pipeline/bodyGuards.ts (VAL-04 size cap that bounds this buffer)
 */

import type { Context } from 'hono'

/**
 * Read the raw request body as an {@link ArrayBuffer}, leaving a later
 * `c.req.json()` (or `zValidator('json')`) in the *same* request able to parse the
 * same bytes (ARCH-08 / SIGN-07).
 *
 * Backed by Hono's body cache via `c.req.arrayBuffer()` — see the module JSDoc for
 * the exact `#cachedBody` mechanism. The returned buffer is fed directly to
 * `crypto.subtle.digest('SHA-256', raw)` by the S6 verifier to re-derive the body
 * hash (no `UNSIGNED-PAYLOAD`, no trust of the client-declared `X-SH-Body-Sha256`).
 *
 * Idempotent: calling it twice (or before/after Hono's own `json()`) returns the
 * cached bytes without re-reading the consumed stream. A bodyless request (GET /
 * DELETE / HEAD, or an empty POST) yields a zero-length `ArrayBuffer` — `digest`
 * of that is the well-defined SHA-256 of the empty string, never a throw.
 *
 * GOTCHA for S6: call `readRawBody(c)` **before** any code path does
 * `c.req.json()`/`zValidator` that *also* needs the bytes — order does not matter
 * for correctness (the cache makes either order parse correctly), but reading raw
 * first keeps the verifier's hashed bytes and the deserializer's parsed bytes
 * provably identical and avoids depending on JSON round-tripping
 * (`JSON.stringify(json)` re-derivation) for the hash.
 *
 * @param c - the Hono request context for the in-flight request.
 * @returns the exact received body bytes as an `ArrayBuffer` (empty if no body).
 */
export async function readRawBody(c: Context): Promise<ArrayBuffer> {
  // Goes through HonoRequest.bodyCache: first call consumes `raw` once and caches
  // the ArrayBuffer; a subsequent c.req.json() re-derives text from this cache
  // rather than re-reading the drained stream. Idempotent on repeat calls.
  return c.req.arrayBuffer()
}
