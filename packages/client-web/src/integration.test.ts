/**
 * Full-loop integration: a (stand-in) generated client driven through a session
 * against the fake auth backend — proving login → CSRF-protected write → token
 * rotation → transparent recovery, exactly as a real SPA + security-core server
 * would behave.
 */

import { describe, expect, it } from 'vitest'
import { browserClientOptions } from './clientOptions.js'
import { createBrowserSession } from './session.js'
import { createFakeAuthBackend } from './test-support.js'
import type { LocationLike } from './types.js'

function fakeLocation(url: string): LocationLike {
  const u = new URL(url)
  return { origin: u.origin, pathname: u.pathname, search: u.search, href: u.href }
}

/** A stand-in for a generated client built from `browserClientOptions`. */
function makeThingsClient(opts: ReturnType<typeof browserClientOptions>) {
  const call = async (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    for (const [k, v] of Object.entries(await opts.headers())) headers.set(k, v)
    return opts.fetch((opts.baseUrl ?? '') + path, { ...init, headers })
  }
  return {
    create: () => call('/things', { method: 'POST', body: '{}' }),
    list: () => call('/things', { method: 'GET' }),
  }
}

describe('client-web end-to-end (fake backend)', () => {
  it('logs in, writes with CSRF, and survives a token rotation', async () => {
    const backend = createFakeAuthBackend()
    const session = createBrowserSession({
      fetch: backend.fetch,
      location: fakeLocation('https://app.example/cb?code=valid-code&state=s'),
      history: { replaceState() {} },
    })

    // 1. Complete the OIDC callback.
    expect((await session.completeLogin()).authenticated).toBe(true)

    // 2. A generated client wired through the session (fake fetch injected; in
    //    prod you omit `fetch` and it defaults to `globalThis.fetch`).
    const things = makeThingsClient(browserClientOptions(session, { fetch: backend.fetch }))

    // 3. A safe read works on the cookie alone.
    expect((await things.list()).status).toBe(200)

    // 4. A write carries the CSRF token and is accepted.
    expect((await things.create()).status).toBe(201)
    expect(backend.acceptedWrites()).toBe(1)

    // 5. Server rotates the CSRF token (privilege change). The next write would
    //    fail with the stale token, but the wrapper refreshes + retries.
    backend.rotateCsrfToken()
    const res = await things.create()
    expect(res.status).toBe(201)
    expect(backend.acceptedWrites()).toBe(2)
    expect(session.getCsrfToken()).toBe(backend.currentCsrfToken())
  })

  it('blocks writes after logout', async () => {
    const backend = createFakeAuthBackend()
    const session = createBrowserSession({
      fetch: backend.fetch,
      location: fakeLocation('https://app.example/cb?code=valid-code&state=s'),
      history: { replaceState() {} },
    })
    await session.completeLogin()
    await session.logout()

    const things = makeThingsClient(browserClientOptions(session, { fetch: backend.fetch }))
    expect((await things.create()).status).toBe(401)
    expect(backend.acceptedWrites()).toBe(0)
  })
})
