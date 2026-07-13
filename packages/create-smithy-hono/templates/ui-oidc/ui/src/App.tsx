import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createBrowserSession,
  browserClientOptions,
  type AuthStatus,
} from '@smithy-hono/client-web'
import { createNotesClient, ApiError, type Note } from './notesClient'

/**
 * The secure SPA. One {@link createBrowserSession} drives the whole OIDC
 * cookie-session flow; the typed Notes client is built from
 * `browserClientOptions(session)` so EVERY call carries the session cookie + the
 * CSRF token automatically (and transparently retries on a CSRF rotation).
 *
 * NOTE on paths: the API mounts the CSRF-token route at `/csrf-token` (not the
 * client-web default `/auth/csrf-token`), so we override `csrfPath`. Login,
 * callback and logout all sit under `/auth`, matching the defaults.
 *
 * NOTE on API base: when the API + SPA are served same-origin under a path prefix
 * (the full-stack deploy mounts the service at `/api`), the build sets
 * `VITE_API_BASE=/api` so every auth + notes path is prefixed. In dev it is empty,
 * so the Vite proxy (which forwards root `/auth`, `/notes`, `/csrf-token`) is
 * unchanged.
 */
const API_BASE = import.meta.env.VITE_API_BASE ?? ''

function makeSession(onChange: (status: AuthStatus) => void) {
  return createBrowserSession({
    // login/callback/logout resolve under `${authBasePath}` (= `${API_BASE}/auth`);
    // the API's csrfTokenHandler is mounted at `${API_BASE}/csrf-token`, outside /auth.
    authBasePath: `${API_BASE}/auth`,
    csrfPath: `${API_BASE}/csrf-token`,
    onChange: (status) => onChange(status),
  })
}

export default function App() {
  // One session for the app's lifetime.
  const sessionRef = useRef<ReturnType<typeof makeSession> | null>(null)
  const [status, setStatus] = useState<AuthStatus>('unknown')
  if (sessionRef.current === null) {
    sessionRef.current = makeSession((s) => setStatus(s))
  }
  const session = sessionRef.current

  // The typed Notes client, rebuilt only if the session identity changes (it won't).
  const notes = useMemo(
    () => createNotesClient(browserClientOptions(session, { baseUrl: API_BASE })),
    [session],
  )

  const [items, setItems] = useState<Note[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [newBody, setNewBody] = useState('')
  const [busy, setBusy] = useState<Set<string>>(new Set())

  const setBusyFor = (id: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev)
      on ? next.add(id) : next.delete(id)
      return next
    })

  const guard = async (fn: () => Promise<void>) => {
    setError(null)
    try {
      await fn()
    } catch (e) {
      if (e instanceof ApiError) setError(`${e.code ?? e.status}: ${e.message}`)
      else setError(e instanceof Error ? e.message : String(e))
    }
  }

  const loadNotes = useCallback(async () => {
    setLoading(true)
    await guard(async () => {
      setItems(await notes.listNotes())
    })
    setLoading(false)
  }, [notes])

  // Boot: finish a login if we just came back from the IdP (?code&state present),
  // else recover an existing session's CSRF token after a reload. Then load notes
  // if we ended up authenticated.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      await guard(async () => {
        await session.completeLogin()
        if (session.status !== 'authenticated') await session.refresh()
      })
      if (!cancelled && session.status === 'authenticated') await loadNotes()
    })()
    return () => {
      cancelled = true
    }
    // session + loadNotes are stable for the app's lifetime.
  }, [session, loadNotes])

  // When status flips to authenticated (e.g. after completeLogin), (re)load notes.
  useEffect(() => {
    if (status === 'authenticated') void loadNotes()
    if (status === 'anonymous') setItems([])
  }, [status, loadNotes])

  const login = () => session.login(location.pathname)
  const logout = () => void session.logout()

  const create = (e: React.FormEvent) => {
    e.preventDefault()
    const title = newTitle.trim()
    if (!title) return
    return guard(async () => {
      const item = await notes.createNote({
        title,
        ...(newBody.trim() ? { body: newBody.trim() } : {}),
      })
      setItems((prev) => [item, ...prev])
      setNewTitle('')
      setNewBody('')
    })
  }

  const remove = (n: Note) =>
    guard(async () => {
      setBusyFor(n.id, true)
      try {
        await notes.deleteNote(n.id)
        setItems((prev) => prev.filter((x) => x.id !== n.id))
      } finally {
        setBusyFor(n.id, false)
      }
    })

  const remaining = useMemo(() => items.length, [items])

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-2xl px-4 py-10">
        <header className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{{APP_NAME}}</h1>
            <p className="mt-1 text-sm text-slate-500">
              React + Tailwind ·{' '}
              <span className="font-mono text-slate-400">@smithy-hono/client-web</span> driving
              the OIDC cookie-session flow ·{' '}
              <span className="rounded bg-slate-200 px-1.5 py-0.5 font-mono text-xs text-slate-600">
                /notes
              </span>
            </p>
          </div>
          <AuthBadge status={status} onLogin={login} onLogout={logout} />
        </header>

        {error && (
          <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
            <span>{error}</span>
            <button
              onClick={() => setError(null)}
              className="shrink-0 font-medium text-red-500 hover:text-red-700"
            >
              dismiss
            </button>
          </div>
        )}

        {status === 'unknown' && (
          <p className="rounded-xl border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-400 shadow-sm">
            Checking your session…
          </p>
        )}

        {status === 'anonymous' && (
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-12 text-center shadow-sm">
            <p className="text-sm text-slate-500">You are not signed in.</p>
            <button
              onClick={login}
              className="mt-4 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700"
            >
              Log in
            </button>
            <p className="mt-3 text-xs text-slate-400">
              Redirects to your IdP via <span className="font-mono">/auth/login</span>.
            </p>
          </div>
        )}

        {status === 'authenticated' && (
          <>
            <form onSubmit={create} className="mb-6 space-y-2">
              <input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Note title…"
                className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm shadow-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
              />
              <div className="flex gap-2">
                <input
                  value={newBody}
                  onChange={(e) => setNewBody(e.target.value)}
                  placeholder="Body (optional)…"
                  className="flex-1 rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm shadow-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
                />
                <button
                  type="submit"
                  disabled={!newTitle.trim()}
                  className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Add
                </button>
              </div>
            </form>

            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
              {loading ? (
                <p className="px-4 py-10 text-center text-sm text-slate-400">Loading…</p>
              ) : items.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-slate-400">
                  No notes yet — add one above.
                </p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {items.map((n) => {
                    const isBusy = busy.has(n.id)
                    return (
                      <li
                        key={n.id}
                        className={`flex items-start gap-3 px-4 py-3 transition ${isBusy ? 'opacity-50' : ''}`}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-slate-800">{n.title}</p>
                          {n.body && (
                            <p className="mt-0.5 truncate text-xs text-slate-500">{n.body}</p>
                          )}
                          <p className="mt-1 font-mono text-[10px] text-slate-400">
                            owner {n.ownerId}
                          </p>
                        </div>
                        <button
                          onClick={() => remove(n)}
                          disabled={isBusy}
                          title="Delete"
                          className="shrink-0 rounded p-1 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                        >
                          ✕
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>

            <footer className="mt-4 flex items-center justify-between px-1 text-xs text-slate-400">
              <span>{remaining} notes</span>
              <button onClick={() => void loadNotes()} className="hover:text-slate-600">
                refresh
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  )
}

function AuthBadge({
  status,
  onLogin,
  onLogout,
}: {
  status: AuthStatus
  onLogin: () => void
  onLogout: () => void
}) {
  if (status === 'authenticated') {
    return (
      <button
        onClick={onLogout}
        className="shrink-0 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
      >
        Log out
      </button>
    )
  }
  if (status === 'anonymous') {
    return (
      <button
        onClick={onLogin}
        className="shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700"
      >
        Log in
      </button>
    )
  }
  return <span className="shrink-0 text-xs text-slate-400">…</span>
}
