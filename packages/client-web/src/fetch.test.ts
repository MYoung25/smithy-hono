import { describe, expect, it, vi } from 'vitest'
import { createCredentialedFetch } from './fetch.js'
import type { CsrfSource, FetchLike } from './types.js'

/** A minimal CsrfSource stub with a controllable token + refresh. */
function stubSource(initial: string | null): CsrfSource & { token: string | null; refreshes: number } {
  const s = {
    token: initial,
    refreshes: 0,
    csrfHeaderName: 'X-CSRF-Token',
    getCsrfToken: () => s.token,
    refresh: async () => {
      s.refreshes++
      return s.token !== null
    },
  }
  return s
}

describe('createCredentialedFetch', () => {
  it('sets credentials: include on every request', async () => {
    const base = vi.fn<FetchLike>(async () => new Response(null, { status: 200 }))
    const fetch = createCredentialedFetch(stubSource('t1'), { fetch: base })
    await fetch('/things')
    expect(base.mock.calls[0]![1]!.credentials).toBe('include')
  })

  it('attaches the CSRF header on writes but not on safe reads', async () => {
    const base = vi.fn<FetchLike>(async () => new Response(null, { status: 200 }))
    const fetch = createCredentialedFetch(stubSource('tok-A'), { fetch: base })

    await fetch('/things', { method: 'POST' })
    expect(new Headers(base.mock.calls[0]![1]!.headers).get('X-CSRF-Token')).toBe('tok-A')

    await fetch('/things', { method: 'GET' })
    expect(new Headers(base.mock.calls[1]![1]!.headers).get('X-CSRF-Token')).toBeNull()
  })

  it('does not attach a header when anonymous', async () => {
    const base = vi.fn<FetchLike>(async () => new Response(null, { status: 200 }))
    const fetch = createCredentialedFetch(stubSource(null), { fetch: base })
    await fetch('/things', { method: 'POST' })
    expect(new Headers(base.mock.calls[0]![1]!.headers).get('X-CSRF-Token')).toBeNull()
  })

  it('refreshes the token and retries once on a CsrfFailed 403', async () => {
    const source = stubSource('stale')
    const csrfFail = () =>
      new Response(JSON.stringify({ code: 'CsrfFailed' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })
    const base = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(csrfFail()) // first write — stale token
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 201 }))
    // refresh() rotates the source's token to the fresh one.
    source.refresh = async () => {
      source.refreshes++
      source.token = 'fresh'
      return true
    }

    const fetch = createCredentialedFetch(source, { fetch: base })
    const res = await fetch('/things', { method: 'POST', body: '{}' })

    expect(res.status).toBe(201)
    expect(source.refreshes).toBe(1)
    expect(base).toHaveBeenCalledTimes(2)
    // The retry carried the FRESH token.
    expect(new Headers(base.mock.calls[1]![1]!.headers).get('X-CSRF-Token')).toBe('fresh')
  })

  it('does not retry when refresh comes back anonymous', async () => {
    const source = stubSource('stale')
    source.refresh = async () => {
      source.refreshes++
      source.token = null
      return false
    }
    const base = vi.fn<FetchLike>(
      async () =>
        new Response(JSON.stringify({ code: 'CsrfFailed' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const fetch = createCredentialedFetch(source, { fetch: base })
    const res = await fetch('/things', { method: 'POST' })
    expect(res.status).toBe(403)
    expect(base).toHaveBeenCalledTimes(1)
  })

  it('does not retry a 403 that is not a CSRF failure', async () => {
    const base = vi.fn<FetchLike>(
      async () =>
        new Response(JSON.stringify({ code: 'AccessDenied' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const source = stubSource('t')
    const fetch = createCredentialedFetch(source, { fetch: base })
    const res = await fetch('/things', { method: 'POST' })
    expect(res.status).toBe(403)
    expect(source.refreshes).toBe(0)
    expect(base).toHaveBeenCalledTimes(1)
  })
})
