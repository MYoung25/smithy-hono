import { describe, expect, it, vi } from 'vitest'
import { createBrowserSession } from './session.js'
import { createFakeAuthBackend } from './test-support.js'
import type { HistoryLike, LocationLike } from './types.js'

/** A mutable fake of `window.location` for a given URL. */
function fakeLocation(url: string): LocationLike {
  const u = new URL(url)
  return {
    origin: u.origin,
    pathname: u.pathname,
    search: u.search,
    href: u.href,
  }
}

function fakeHistory(): HistoryLike & { last?: string | null } {
  const h: HistoryLike & { last?: string | null } = {
    replaceState(_data, _unused, target) {
      h.last = target ?? null
    },
  }
  return h
}

describe('BrowserSession.login', () => {
  it('navigates full-page to the login initiator with returnTo preserved', () => {
    const location = fakeLocation('https://app.example/dashboard')
    const session = createBrowserSession({ location })
    session.login('/dashboard')
    expect(location.href).toBe('https://app.example/auth/login?returnTo=%2Fdashboard')
  })

  it('honors a custom loginPath', () => {
    const location = fakeLocation('https://app.example/')
    const session = createBrowserSession({ location, loginPath: '/signin' })
    session.login()
    expect(location.href).toBe('https://app.example/signin')
  })
})

describe('BrowserSession.completeLogin', () => {
  it('is a safe no-op when there is no callback query', async () => {
    const backend = createFakeAuthBackend()
    const session = createBrowserSession({
      fetch: backend.fetch,
      location: fakeLocation('https://app.example/'),
      history: fakeHistory(),
    })
    const result = await session.completeLogin()
    expect(result).toEqual({ authenticated: false })
    expect(session.status).toBe('unknown')
  })

  it('exchanges the code, captures the CSRF token, and scrubs the URL', async () => {
    const backend = createFakeAuthBackend({ validCode: 'valid-code' })
    const history = fakeHistory()
    const onChange = vi.fn()
    const session = createBrowserSession({
      fetch: backend.fetch,
      location: fakeLocation('https://app.example/auth/landing?code=valid-code&state=xyz'),
      history,
      onChange,
    })

    const result = await session.completeLogin()

    expect(result.authenticated).toBe(true)
    expect(session.status).toBe('authenticated')
    expect(session.getCsrfToken()).toBe(backend.currentCsrfToken())
    // code/state stripped — replaceState fell back to the pathname.
    expect(history.last).toBe('/auth/landing')
    expect(onChange).toHaveBeenCalledWith('authenticated', session.getCsrfToken())
  })

  it('returns and navigates to a same-origin returnTo', async () => {
    const backend = createFakeAuthBackend()
    const history = fakeHistory()
    const session = createBrowserSession({
      fetch: backend.fetch,
      location: fakeLocation(
        'https://app.example/auth/landing?code=valid-code&state=s&returnTo=%2Fprojects',
      ),
      history,
    })
    const result = await session.completeLogin()
    expect(result).toEqual({ authenticated: true, returnTo: '/projects' })
    expect(history.last).toBe('/projects')
  })

  it('ignores a non-same-origin returnTo (open-redirect defense)', async () => {
    const backend = createFakeAuthBackend()
    const history = fakeHistory()
    const session = createBrowserSession({
      fetch: backend.fetch,
      location: fakeLocation(
        'https://app.example/cb?code=valid-code&state=s&returnTo=https%3A%2F%2Fevil.test',
      ),
      history,
    })
    const result = await session.completeLogin()
    expect(result).toEqual({ authenticated: true })
    expect(history.last).toBe('/cb')
  })

  // The WHATWG URL parser normalizes `\` to `/`, so a leading-`/` prefix check is
  // bypassable: `/\evil.com` and `/\/evil.com` both resolve to a foreign origin.
  it.each(['%2F%5Cevil.com', '%2F%5C%2Fevil.com', '%2F%5C%5Cevil.com'])(
    'ignores a backslash-bypass returnTo (open-redirect defense): %s',
    async (encoded) => {
      const backend = createFakeAuthBackend()
      const history = fakeHistory()
      const session = createBrowserSession({
        fetch: backend.fetch,
        location: fakeLocation(`https://app.example/cb?code=valid-code&state=s&returnTo=${encoded}`),
        history,
      })
      const result = await session.completeLogin()
      expect(result).toEqual({ authenticated: true })
      expect(history.last).toBe('/cb')
    },
  )

  it('normalizes a same-origin returnTo to its path+search+hash', async () => {
    const backend = createFakeAuthBackend()
    const history = fakeHistory()
    const session = createBrowserSession({
      fetch: backend.fetch,
      location: fakeLocation(
        'https://app.example/cb?code=valid-code&state=s&returnTo=%2Fprojects%3Ftab%3D1%23top',
      ),
      history,
    })
    const result = await session.completeLogin()
    expect(result).toEqual({ authenticated: true, returnTo: '/projects?tab=1#top' })
    expect(history.last).toBe('/projects?tab=1#top')
  })

  it('stays anonymous on a rejected code', async () => {
    const backend = createFakeAuthBackend({ validCode: 'valid-code' })
    const session = createBrowserSession({
      fetch: backend.fetch,
      location: fakeLocation('https://app.example/cb?code=WRONG&state=s'),
      history: fakeHistory(),
    })
    const result = await session.completeLogin()
    expect(result).toEqual({ authenticated: false })
    expect(session.status).toBe('anonymous')
    expect(session.getCsrfToken()).toBeNull()
  })
})

describe('BrowserSession.refresh', () => {
  it('recovers the token from an existing session', async () => {
    const backend = createFakeAuthBackend()
    // Seed a session via the callback first.
    await createBrowserSession({
      fetch: backend.fetch,
      location: fakeLocation('https://app.example/cb?code=valid-code&state=s'),
      history: fakeHistory(),
    }).completeLogin()

    // A fresh session object (simulating a reload — in-memory token gone).
    const reloaded = createBrowserSession({ fetch: backend.fetch, location: fakeLocation('https://app.example/') })
    expect(reloaded.getCsrfToken()).toBeNull()
    const ok = await reloaded.refresh()
    expect(ok).toBe(true)
    expect(reloaded.status).toBe('authenticated')
    expect(reloaded.getCsrfToken()).toBe(backend.currentCsrfToken())
  })

  it('reports anonymous when there is no session', async () => {
    const backend = createFakeAuthBackend()
    const session = createBrowserSession({ fetch: backend.fetch, location: fakeLocation('https://app.example/') })
    const ok = await session.refresh()
    expect(ok).toBe(false)
    expect(session.status).toBe('anonymous')
  })
})

describe('BrowserSession.logout', () => {
  it('revokes the session and drops to anonymous', async () => {
    const backend = createFakeAuthBackend()
    const session = createBrowserSession({
      fetch: backend.fetch,
      location: fakeLocation('https://app.example/cb?code=valid-code&state=s'),
      history: fakeHistory(),
    })
    await session.completeLogin()
    expect(backend.isAuthenticated()).toBe(true)

    await session.logout()
    expect(backend.isAuthenticated()).toBe(false)
    expect(session.status).toBe('anonymous')
    expect(session.getCsrfToken()).toBeNull()
  })
})

describe('BrowserSession.authHeaders', () => {
  it('is empty when anonymous and carries the token when authenticated', async () => {
    const backend = createFakeAuthBackend()
    const session = createBrowserSession({
      fetch: backend.fetch,
      location: fakeLocation('https://app.example/cb?code=valid-code&state=s'),
      history: fakeHistory(),
    })
    expect(await session.authHeaders()).toEqual({})
    await session.completeLogin()
    expect(await session.authHeaders()).toEqual({ 'X-CSRF-Token': session.getCsrfToken() })
  })
})
