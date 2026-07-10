// Runtime/behavioral validator harness (CG-11).
//
// Snapshot tests assert the emitted TEXT; TypeCheckTest asserts it COMPILES.
// Neither pushes a real request through a generated zValidator — which is exactly
// why CG-01 (string-form query/path/header numbers rejected) and CG-02 (enum
// member-name vs wire-value) survived: both produce compiling, snapshot-stable,
// behaviorally WRONG validators. This suite mounts the generated router in an
// in-memory Hono app and drives requests through it, asserting accept/reject.
//
// The generated/ dir is produced by CoverageRegenTool:
//   ./gradlew test --tests '*CoverageRegenTool*' -DREGEN_COVERAGE=true
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { createCoverageRouter, type CoverageOperations } from '../generated/coverage.gen'
import { OPERATIONS } from '../generated/registry.gen'

// Echo ops: every operation returns its input verbatim, so the test can inspect
// the *types* the validators produced (a JSON number vs string is observable).
function makeApp() {
  const ops: CoverageOperations = {
    async EchoParams(input) {
      return {
        count: input.count,
        limit: input.limit,
        ratio: input.ratio,
        flag: input.flag,
        // The generated INPUT interface types an enum member as `string` (toTsType
        // ENUM → string) while the OUTPUT type infers the literal union, so the echo
        // needs a narrowing cast. The runtime value is unchanged.
        status: input.status as 'active' | 'inactive' | undefined,
        size: input.size,
        headerCount: input.headerCount,
      }
    },
    async CreateThing(input) {
      return { item: input.body }
    },
    async EchoMaps(input) {
      return { id: input.id, known: input.known, filters: input.filters, meta: input.meta }
    },
    async Reserved(input) {
      // Reserved-word property access must type-check (CG-09).
      return { ok: input.body.class.length >= 0 }
    },
    async MakeWidget(input) {
      return { id: 'w1', code: 202, location: `/widgets/w1?name=${input.body.name}` }
    },
    async PutShapes(input) {
      return { ok: true, items: input.body.items }
    },
  }
  const app = new Hono()
  app.route('/', createCoverageRouter(ops))
  return app
}

// ── CG-01: path/query/header params arrive as strings and must coerce ──────────

describe('CG-01 — string-form path/query/header coercion', () => {
  it('coerces @httpLabel/@httpQuery/@httpHeader string wire forms to their types', async () => {
    const app = makeApp()
    const res = await app.request('/echo/42?limit=5&ratio=1.5&flag=true&status=active', {
      headers: { 'X-Count': '7' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    // Numbers arrive as strings on the wire; the validator must coerce them.
    expect(body.count).toBe(42)
    expect(typeof body.count).toBe('number')
    expect(body.limit).toBe(5)
    expect(typeof body.limit).toBe('number')
    expect(body.ratio).toBe(1.5)
    expect(typeof body.ratio).toBe('number')
    expect(body.flag).toBe(true)
    expect(typeof body.flag).toBe('boolean')
    expect(body.status).toBe('active')
    // The header value must reach the handler coerced, not as the raw string.
    expect(body.headerCount).toBe(7)
    expect(typeof body.headerCount).toBe('number')
  })

  it('coerces boolean "false" to false (NOT true — the z.coerce.boolean footgun)', async () => {
    const app = makeApp()
    const res = await app.request('/echo/1?flag=false')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.flag).toBe(false)
  })

  it('rejects a non-numeric @httpLabel (400)', async () => {
    const app = makeApp()
    const res = await app.request('/echo/notanumber')
    expect(res.status).toBe(400)
  })

  it('rejects a non-numeric @httpQuery number (400)', async () => {
    const app = makeApp()
    const res = await app.request('/echo/1?limit=abc')
    expect(res.status).toBe(400)
  })

  it('rejects a non-boolean @httpQuery boolean (400)', async () => {
    const app = makeApp()
    const res = await app.request('/echo/1?flag=notabool')
    expect(res.status).toBe(400)
  })
})

// ── CG-04: @range on a target shape must reach the validator ───────────────────

describe('CG-04 — @range on the target shape constrains the validator', () => {
  it('accepts an in-range coerced @httpQuery number (size=10)', async () => {
    const app = makeApp()
    const res = await app.request('/echo/1?size=10')
    expect(res.status).toBe(200)
    expect((await res.json()).size).toBe(10)
  })

  it('rejects an over-range @httpQuery number (size=999 > max 50)', async () => {
    const app = makeApp()
    const res = await app.request('/echo/1?size=999')
    expect(res.status).toBe(400)
  })

  it('rejects an under-range @httpQuery number (size=0 < min 1)', async () => {
    const app = makeApp()
    const res = await app.request('/echo/1?size=0')
    expect(res.status).toBe(400)
  })

  it('rejects an over-range number in a JSON body (target-shape @range)', async () => {
    const app = makeApp()
    const res = await app.request('/things', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ count: 5, flag: true, status: 'active', level: 1, size: 999 }),
    })
    expect(res.status).toBe(400)
  })
})

// ── CG-01: JSON body members must stay STRICT (no coercion) ────────────────────

describe('CG-01 — JSON body members stay strict', () => {
  const valid = { count: 5, flag: true, status: 'active', level: 1 }

  it('accepts a well-typed JSON body (201)', async () => {
    const app = makeApp()
    const res = await app.request('/things', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(valid),
    })
    expect(res.status).toBe(201)
    expect((await res.json()).item).toEqual(valid)
  })

  it('rejects a string-form number in the JSON body (400 — body must not coerce)', async () => {
    const app = makeApp()
    const res = await app.request('/things', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...valid, count: '5' }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects a string-form boolean in the JSON body (400)', async () => {
    const app = makeApp()
    const res = await app.request('/things', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...valid, flag: 'true' }),
    })
    expect(res.status).toBe(400)
  })
})

// ── CG-05: @httpQueryParams / @httpPrefixHeaders catch-all map bindings ────────

describe('CG-05 — @httpQueryParams and @httpPrefixHeaders', () => {
  it('binds the full query map MINUS explicit @httpQuery params', async () => {
    const app = makeApp()
    const res = await app.request('/maps/7?known=k1&a=1&b=2')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe('7')
    expect(body.known).toBe('k1')
    // `known` is an explicit @httpQuery member, so it must NOT appear in the catch-all.
    expect(body.filters).toEqual({ a: '1', b: '2' })
  })

  it('binds prefix-matched headers with the prefix stripped', async () => {
    const app = makeApp()
    const res = await app.request('/maps/7', {
      headers: { 'X-Meta-Foo': 'f', 'X-Meta-Bar': 'bb', 'X-Other': 'ignored' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    // Prefix stripped, header names lowercased by the runtime; non-matching header excluded.
    expect(body.meta).toEqual({ foo: 'f', bar: 'bb' })
  })

  it('yields an empty map when no params / prefixed headers are present', async () => {
    const app = makeApp()
    const res = await app.request('/maps/7')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.filters).toEqual({})
    expect(body.meta).toEqual({})
  })
})

// ── CG-10: shape coverage (timestamp/uniqueItems/map-key/bignum/blob/default) ──

describe('CG-10 — shape coverage', () => {
  function post(body: unknown) {
    return makeApp().request('/shapes2', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('(1) @timestampFormat epoch-seconds accepts a number, rejects an ISO string', async () => {
    expect((await post({ epochTs: 1700000000 })).status).toBe(200)
    expect((await post({ epochTs: '2024-01-01T00:00:00.000Z' })).status).toBe(400)
  })

  it('(2) @uniqueItems rejects a list with duplicates', async () => {
    expect((await post({ tags: ['a', 'b'] })).status).toBe(200)
    expect((await post({ tags: ['a', 'a'] })).status).toBe(400)
  })

  it('(3) constrained map key (enum) rejects an out-of-enum key', async () => {
    expect((await post({ byStatus: { active: 3 } })).status).toBe(200)
    expect((await post({ byStatus: { bogus: 3 } })).status).toBe(400)
  })

  it('(4) bigInteger accepts a numeric string, rejects non-numeric / decimal', async () => {
    expect((await post({ bignum: '123456789012345678901234567890' })).status).toBe(200)
    expect((await post({ bignum: 'abc' })).status).toBe(400)
    expect((await post({ bignum: '12.5' })).status).toBe(400)
  })

  it('(5) blob accepts valid base64, rejects non-base64', async () => {
    expect((await post({ data: 'SGVsbG8=' })).status).toBe(200)
    expect((await post({ data: 'not base64!!' })).status).toBe(400)
  })

  it('(6) array @default fills [] when the field is omitted (not null)', async () => {
    const res = await post({})
    expect(res.status).toBe(200)
    expect((await res.json()).items).toEqual([])
  })
})

// ── RT-13: @sensitive field paths in the registry ─────────────────────────────

describe('RT-13 — sensitiveFields in the registry', () => {
  it('emits the @sensitive member dot-paths for an op (input + output)', () => {
    expect(OPERATIONS.CreateThing.sensitiveFields).toEqual(['body.secret', 'item.secret'])
  })

  it('omits sensitiveFields for an op with no @sensitive members', () => {
    expect(OPERATIONS.EchoParams.sensitiveFields).toBeUndefined()
  })
})

// ── CG-06: output bindings (@httpResponseCode + output @httpHeader) ────────────

describe('CG-06 — output bindings', () => {
  it('uses @httpResponseCode for status, @httpHeader for a response header, and excludes both from the body', async () => {
    const app = makeApp()
    const res = await app.request('/widgets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'gadget' }),
    })
    // Status comes from the @httpResponseCode output member (202), not the static @http code (201).
    expect(res.status).toBe(202)
    // The @httpHeader output member is emitted as a response header.
    expect(res.headers.get('X-Widget-Location')).toBe('/widgets/w1?name=gadget')
    // The status/header members must NOT leak into the JSON body.
    expect(await res.json()).toEqual({ id: 'w1' })
  })
})

// ── CG-09: reserved-word keys + global-colliding type names ────────────────────

describe('CG-09 — reserved/global identifier handling', () => {
  it('accepts a body with reserved-word members (class/default) and a Number-typed field', async () => {
    const app = makeApp()
    const res = await app.request('/reserved', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ class: 'x', default: 'y', num: { amount: 3 } }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it('rejects a body missing the required reserved-word member (class)', async () => {
    const app = makeApp()
    const res = await app.request('/reserved', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ default: 'y' }),
    })
    expect(res.status).toBe(400)
  })
})

// ── CG-03: union uses the restJson1 single-key wire shape ──────────────────────

describe('CG-03 — union single-key wire shape', () => {
  const base = { count: 5, flag: true, status: 'active', level: 1 }

  it('accepts a single-key union variant ({ circle: { radius } })', async () => {
    const app = makeApp()
    const res = await app.request('/things', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, shape: { circle: { radius: 3 } } }),
    })
    expect(res.status).toBe(201)
    expect((await res.json()).item.shape).toEqual({ circle: { radius: 3 } })
  })

  it('accepts a different variant ({ label: "x" })', async () => {
    const app = makeApp()
    const res = await app.request('/things', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, shape: { label: 'hi' } }),
    })
    expect(res.status).toBe(201)
  })

  it('rejects the legacy { type, value } encoding', async () => {
    const app = makeApp()
    const res = await app.request('/things', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, shape: { type: 'circle', value: { radius: 3 } } }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects a two-variant object (exactly-one enforced)', async () => {
    const app = makeApp()
    const res = await app.request('/things', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, shape: { circle: { radius: 3 }, label: 'hi' } }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects an empty union object (no variant)', async () => {
    const app = makeApp()
    const res = await app.request('/things', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, shape: {} }),
    })
    expect(res.status).toBe(400)
  })
})

// ── CG-02: enum validates the wire VALUE, not the member NAME ───────────────────

describe('CG-02 — enum wire values', () => {
  const base = { count: 5, flag: true, level: 1 }

  it('accepts the explicit enum wire value ("active")', async () => {
    const app = makeApp()
    const res = await app.request('/things', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, status: 'active' }),
    })
    expect(res.status).toBe(201)
    expect((await res.json()).item.status).toBe('active')
  })

  it('rejects the enum member NAME ("ACTIVE")', async () => {
    const app = makeApp()
    const res = await app.request('/things', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, status: 'ACTIVE' }),
    })
    expect(res.status).toBe(400)
  })

  it('accepts a valid intEnum integer value (10)', async () => {
    const app = makeApp()
    const res = await app.request('/things', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ count: 5, flag: true, status: 'active', level: 10 }),
    })
    expect(res.status).toBe(201)
    expect((await res.json()).item.level).toBe(10)
  })

  it('rejects an integer outside the intEnum (5)', async () => {
    const app = makeApp()
    const res = await app.request('/things', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ count: 5, flag: true, status: 'active', level: 5 }),
    })
    expect(res.status).toBe(400)
  })

  it('coerces an enum @httpQuery wire value ("active")', async () => {
    const app = makeApp()
    const res = await app.request('/echo/1?status=active')
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('active')
  })
})
