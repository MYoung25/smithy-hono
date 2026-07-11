import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import {
  bodyGuards,
  headerGuards,
  assertWithinStructuralLimits,
  readBoundedBody,
  BodyTooLargeError,
  StructuralLimitError,
  DEFAULT_STRUCTURAL_LIMITS,
} from './bodyGuards.js'
import type { ValidationConfig } from './bodyGuards.js'
import type { SecurityConfig } from '../config.js'
import type { OperationRegistry, PipelineOperationMeta } from './index.js'
import { resolveOp } from './index.js'

const OPERATIONS: OperationRegistry = {
  CreateTodo: {
    name: 'CreateTodo',
    method: 'POST',
    path: '/todos',
    authSchemes: [{ type: 'oidc' }],
    readonly: false,
    requiredPermissions: ['todos.write'],
    cost: 1,
    constraints: { hasConstrainedInput: false },
  },
  ListTodos: {
    name: 'ListTodos',
    method: 'GET',
    path: '/todos',
    authSchemes: [{ type: 'anonymous' }],
    readonly: true,
    requiredPermissions: [],
    cost: 1,
    constraints: { hasConstrainedInput: false },
  },
  TinyOp: {
    name: 'TinyOp',
    method: 'POST',
    path: '/tiny',
    authSchemes: [{ type: 'oidc' }],
    readonly: false,
    requiredPermissions: [],
    cost: 1,
    // Per-op override: cap this op at 10 bytes (VAL-04).
    constraints: { hasConstrainedInput: false, maxBodyBytes: 10 },
  },
}

function makeConfig(): SecurityConfig & ValidationConfig {
  return {
    allowedOrigins: ['https://app.example.com'],
    hsts: { maxAge: 31536000, includeSubDomains: true },
    idleTtlSeconds: 900,
    stores: {},
    maxBodyBytes: 1024,
    protocolContentType: 'application/json',
  }
}

function makeApp(): Hono {
  const app = new Hono()
  const config = makeConfig()
  // Mirror the real pipeline (PIPELINE-MW-01): the cheap header-only stage runs
  // first (honest-CL 413 / content-type 415), then the body stage (during-read cap
  // + structural walk). Together they reproduce the pre-split bodyGuards behavior.
  app.use('*', headerGuards(config, resolveOp(OPERATIONS)))
  app.use('*', bodyGuards(config, resolveOp(OPERATIONS)))
  app.post('/todos', (c) => c.json({ ok: true }, 201))
  app.post('/tiny', (c) => c.json({ ok: true }, 201))
  app.get('/todos', (c) => c.json({ items: [] }, 200))
  // Echoes the parsed body so a test can prove the downstream deserializer still
  // reads the (bounded, rebuilt) body after bodyGuards consumed the raw stream.
  app.post('/echo', async (c) => c.json(await c.req.json(), 200))
  return app
}

/** A `ReadableStream` that emits exactly `bytes` bytes of 'x', in `chunk`-sized pieces. */
function byteStream(bytes: number, chunk = 256): ReadableStream<Uint8Array> {
  let sent = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes) {
        controller.close()
        return
      }
      const size = Math.min(chunk, bytes - sent)
      controller.enqueue(new Uint8Array(size).fill(0x78)) // 'x'
      sent += size
    },
  })
}

/**
 * Build a streaming Request with NO auto Content-Length (stream bodies don't get
 * one) so callers can model chunked / Content-Length-absent / lying-Content-Length
 * payloads. `duplex: 'half'` is required for a stream body.
 */
function streamRequest(
  path: string,
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string>,
): Request {
  const init: RequestInit & { duplex: 'half' } = { method: 'POST', headers, body, duplex: 'half' }
  return new Request(`http://localhost${path}`, init)
}

describe('bodyGuards — body size (VAL-04)', () => {
  it('rejects an oversized Content-Length with 413 before the handler runs', async () => {
    const res = await makeApp().request('/todos', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(2048), // > config.maxBodyBytes (1024)
      },
      body: 'x'.repeat(2048),
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ code: 'PayloadTooLarge' })
  })

  it('honors the per-operation maxBodyBytes override', async () => {
    const res = await makeApp().request('/tiny', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(50), // > TinyOp override (10), < global (1024)
      },
      body: 'x'.repeat(50),
    })
    expect(res.status).toBe(413)
  })

  it('allows a request within the limit', async () => {
    const res = await makeApp().request('/todos', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(10),
      },
      body: '{"a":"b"}',
    })
    expect(res.status).toBe(201)
  })
})

describe('bodyGuards — during-read byte cap (RT-01: chunked / lying / absent CL)', () => {
  it('rejects a Content-Length-absent (chunked) body over the cap with 413', async () => {
    // No content-length header → the declared-CL fast-path is bypassed; only the
    // during-read cap can stop it. 2048 bytes > config.maxBodyBytes (1024).
    const res = await makeApp().request(
      streamRequest('/todos', byteStream(2048), { 'content-type': 'application/json' }),
    )
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ code: 'PayloadTooLarge' })
  })

  it('rejects a lying-small Content-Length whose real body exceeds the cap (413)', async () => {
    // Header claims 5 bytes (passes the fast-path: 5 < 1024) but the stream sends
    // 2048 — the during-read counter catches the real size.
    const res = await makeApp().request(
      streamRequest('/todos', byteStream(2048), {
        'content-type': 'application/json',
        'content-length': '5',
      }),
    )
    expect(res.status).toBe(413)
  })

  it('honors the per-op override against a chunked over-cap body', async () => {
    // TinyOp caps at 10 bytes; a 64-byte chunked body must 413.
    const res = await makeApp().request(
      streamRequest('/tiny', byteStream(64), { 'content-type': 'application/json' }),
    )
    expect(res.status).toBe(413)
  })

  it('lets a chunked body under the cap through and the handler still parses it', async () => {
    const json = JSON.stringify({ a: 'b', n: 1 })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(json))
        controller.close()
      },
    })
    const res = await makeApp().request(
      streamRequest('/echo', body, { 'content-type': 'application/json' }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ a: 'b', n: 1 })
  })
})

describe('readBoundedBody (RT-01)', () => {
  it('returns the full bytes when under the limit', async () => {
    const out = await readBoundedBody(byteStream(100), 1024)
    expect(out.byteLength).toBe(100)
  })

  it('throws BodyTooLargeError the moment the stream crosses the limit', async () => {
    await expect(readBoundedBody(byteStream(2048), 1024)).rejects.toBeInstanceOf(BodyTooLargeError)
  })

  it('treats a null body as an empty payload', async () => {
    const out = await readBoundedBody(null, 1024)
    expect(out.byteLength).toBe(0)
  })

  it('accepts a body exactly at the limit', async () => {
    const out = await readBoundedBody(byteStream(1024), 1024)
    expect(out.byteLength).toBe(1024)
  })
})

describe('bodyGuards — structural limits invoked (RT-02 / VAL-05)', () => {
  // A nested object payload `depth` levels deep, small in bytes (well under the cap).
  function nestedJson(depth: number): string {
    let s = '1'
    for (let i = 0; i < depth; i++) s = `{"a":${s}}`
    return s
  }

  it('rejects a payload nested past maxDepth (413) before the handler runs', async () => {
    const res = await makeApp().request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: nestedJson(DEFAULT_STRUCTURAL_LIMITS.maxDepth + 5),
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ code: 'PayloadTooLarge' })
  })

  it('rejects an array longer than maxArrayLength (413)', async () => {
    // A 12k-element array of 0s is small in bytes but breaches maxArrayLength (10k).
    const arr = JSON.stringify(new Array(DEFAULT_STRUCTURAL_LIMITS.maxArrayLength + 1).fill(0))
    const res = await makeApp().request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: arr,
    })
    expect(res.status).toBe(413)
  })

  it('lets a legitimately nested payload within limits through to the handler', async () => {
    const res = await makeApp().request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: nestedJson(5),
    })
    expect(res.status).toBe(200)
  })

  it('honors a custom structuralLimits override from config', async () => {
    const app = new Hono()
    app.use('*', bodyGuards(
      { ...makeConfig(), structuralLimits: { maxDepth: 2, maxArrayLength: 10, maxObjectKeys: 10 } },
      resolveOp(OPERATIONS),
    ))
    app.post('/echo', async (c) => c.json(await c.req.json(), 200))
    const res = await app.request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: nestedJson(5), // > the custom maxDepth of 2
    })
    expect(res.status).toBe(413)
  })

  it('defers malformed JSON to the per-op validator (no structural 413)', async () => {
    // Not valid JSON — bodyGuards must not 413; the body passes through unchanged.
    const res = await makeApp().request('/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    // /todos handler ignores the body and returns 201; the point is: not a 413.
    expect(res.status).not.toBe(413)
  })
})

describe('bodyGuards — content-type (VAL-06)', () => {
  it('rejects a POST with a wrong content-type with 415', async () => {
    const res = await makeApp().request('/todos', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    })
    expect(res.status).toBe(415)
    expect(await res.json()).toEqual({ code: 'UnsupportedMediaType' })
  })

  it('accepts the modeled application/json content-type (with charset param)', async () => {
    const res = await makeApp().request('/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: '{"a":"b"}',
    })
    expect(res.status).toBe(201)
  })

  it('lets a bodyless GET pass without a content-type', async () => {
    const res = await makeApp().request('/todos', { method: 'GET' })
    expect(res.status).toBe(200)
  })

  it('does NOT bypass VAL-06 on a malformed (NaN) Content-Length (finding pipeline-mw val-04/05/06)', async () => {
    // A malformed/duplicate Content-Length parses to NaN; previously `NaN > 0` was
    // false so hasBody=false skipped the content-type check entirely. The guard now
    // treats an untrustworthy declared length as "body present, size unknown".
    const req = new Request('http://localhost/todos', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'content-length': 'abc' },
    })
    const res = await makeApp().request(req)
    expect(res.status).toBe(415)
    expect(await res.json()).toEqual({ code: 'UnsupportedMediaType' })
  })
})

describe('headerGuards / bodyGuards split (PIPELINE-MW-01)', () => {
  function headerApp(): Hono {
    const app = new Hono()
    app.use('*', headerGuards(makeConfig(), resolveOp(OPERATIONS)))
    app.post('/todos', (c) => c.json({ ok: true }, 201))
    return app
  }

  it('headerGuards 413s an honest oversize Content-Length on headers alone (no body read)', async () => {
    const res = await headerApp().request('/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(2048) },
      body: 'x'.repeat(2048),
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ code: 'PayloadTooLarge' })
  })

  it('headerGuards 415s a wrong content-type on headers alone', async () => {
    const res = await headerApp().request('/todos', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    })
    expect(res.status).toBe(415)
    expect(await res.json()).toEqual({ code: 'UnsupportedMediaType' })
  })

  it('bodyGuards (body stage) does NOT enforce content-type — that moved to headerGuards', async () => {
    // Standalone bodyGuards must not 415; a non-JSON body is just deferred to the
    // per-op validator (the header stage owns 415 now).
    const app = new Hono()
    app.use('*', bodyGuards(makeConfig(), resolveOp(OPERATIONS)))
    app.post('/todos', (c) => c.json({ ok: true }, 201))
    const res = await app.request('/todos', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    })
    expect(res.status).not.toBe(415)
  })

  it('bodyGuards (body stage) still enforces the during-read byte cap (413)', async () => {
    const app = new Hono()
    app.use('*', bodyGuards(makeConfig(), resolveOp(OPERATIONS)))
    app.post('/todos', (c) => c.json({ ok: true }, 201))
    const res = await app.request(
      streamRequest('/todos', byteStream(2048), { 'content-type': 'application/json' }),
    )
    expect(res.status).toBe(413)
  })
})

describe('assertWithinStructuralLimits — structural limits (VAL-05)', () => {
  it('accepts a payload within the default bounds', () => {
    expect(() =>
      assertWithinStructuralLimits({ a: 1, b: [1, 2, 3], c: { d: 'x' } }),
    ).not.toThrow()
  })

  it('rejects nesting deeper than maxDepth', () => {
    let deep: unknown = 'leaf'
    for (let i = 0; i <= DEFAULT_STRUCTURAL_LIMITS.maxDepth + 1; i++) {
      deep = { nested: deep }
    }
    expect(() => assertWithinStructuralLimits(deep)).toThrow(StructuralLimitError)
  })

  it('rejects an array longer than maxArrayLength', () => {
    const huge = new Array(DEFAULT_STRUCTURAL_LIMITS.maxArrayLength + 1).fill(0)
    expect(() => assertWithinStructuralLimits(huge)).toThrow(StructuralLimitError)
  })

  it('rejects an object with too many keys', () => {
    const wide: Record<string, number> = {}
    for (let i = 0; i <= DEFAULT_STRUCTURAL_LIMITS.maxObjectKeys; i++) wide[`k${i}`] = i
    expect(() => assertWithinStructuralLimits(wide)).toThrow(StructuralLimitError)
  })

  it('respects custom limits', () => {
    expect(() =>
      assertWithinStructuralLimits({ a: { b: { c: 1 } } }, {
        maxDepth: 1,
        maxArrayLength: 10,
        maxObjectKeys: 10,
      }),
    ).toThrow(StructuralLimitError)
  })
})
