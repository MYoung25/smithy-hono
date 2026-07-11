import { describe, it, expect } from 'vitest'
import app from '../src/server'

// OPS-04 — the wired example exposes health/readiness that BYPASS the security
// pipeline (registered before it), so a probe is never rejected by assertHttps or
// rate limiting. (Importing ../src/server also exercises the OPS-06 validateConfig()
// call at module load — a throw there would fail this suite.)
describe('OPS-04 — health/readiness endpoints', () => {
  it('GET /healthz → 200 ok, bypassing the pipeline (no TLS/auth rejection)', async () => {
    const res = await app.request('/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('GET /readyz → 200 ready (configured stores respond)', async () => {
    const res = await app.request('/readyz')
    expect(res.status).toBe(200)
    expect((await res.json() as { status: string }).status).toBe('ready')
  })

  it('a normal route still goes through the pipeline (fail-closed TLS in dev) → 400', async () => {
    // No TRUST_PROXY_HEADERS → assertHttps rejects the plaintext request, proving the
    // pipeline runs for /todos but NOT for the health routes above.
    const res = await app.request('/todos')
    expect(res.status).toBe(400)
  })
})
