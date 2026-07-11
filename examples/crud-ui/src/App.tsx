import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type Task } from './api'

const PAGE_SIZE = 5 // small, to show off cursor pagination

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [nextToken, setNextToken] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

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
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const loadFirst = useCallback(async () => {
    setLoading(true)
    await guard(async () => {
      const page = await api.list(PAGE_SIZE)
      setTasks(page.items)
      setNextToken(page.nextToken)
    })
    setLoading(false)
  }, [])

  useEffect(() => {
    void loadFirst()
  }, [loadFirst])

  const loadMore = () =>
    guard(async () => {
      if (!nextToken) return
      const page = await api.list(PAGE_SIZE, nextToken)
      setTasks((prev) => [...prev, ...page.items])
      setNextToken(page.nextToken)
    })

  const create = (e: React.FormEvent) => {
    e.preventDefault()
    const title = newTitle.trim()
    if (!title) return
    return guard(async () => {
      const { item } = await api.create({ title, done: false })
      setTasks((prev) => [item, ...prev]) // optimistic prepend
      setNewTitle('')
    })
  }

  const toggle = (t: Task) =>
    guard(async () => {
      setBusyFor(t.id, true)
      try {
        const { item } = await api.update(t.id, { title: t.title, done: !t.done })
        setTasks((prev) => prev.map((x) => (x.id === item.id ? item : x)))
      } finally {
        setBusyFor(t.id, false)
      }
    })

  const saveEdit = (t: Task) =>
    guard(async () => {
      const title = draft.trim()
      if (!title || title === t.title) {
        setEditingId(null)
        return
      }
      setBusyFor(t.id, true)
      try {
        const { item } = await api.update(t.id, { title, done: t.done })
        setTasks((prev) => prev.map((x) => (x.id === item.id ? item : x)))
        setEditingId(null)
      } finally {
        setBusyFor(t.id, false)
      }
    })

  const remove = (t: Task) =>
    guard(async () => {
      setBusyFor(t.id, true)
      try {
        await api.remove(t.id)
        setTasks((prev) => prev.filter((x) => x.id !== t.id))
      } finally {
        setBusyFor(t.id, false)
      }
    })

  const remaining = useMemo(() => tasks.filter((t) => !t.done).length, [tasks])

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-2xl px-4 py-10">
        <header className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight">Tasks</h1>
          <p className="mt-1 text-sm text-slate-500">
            React + Tailwind demo UI ·{' '}
            <span className="font-mono text-slate-400">smithy-hono</span> zero-handler
            CRUD ·{' '}
            <span className="rounded bg-slate-200 px-1.5 py-0.5 font-mono text-xs text-slate-600">
              GET/POST/PUT/DELETE /tasks
            </span>
          </p>
        </header>

        <form onSubmit={create} className="mb-6 flex gap-2">
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Add a task…"
            className="flex-1 rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm shadow-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
          />
          <button
            type="submit"
            disabled={!newTitle.trim()}
            className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Add
          </button>
        </form>

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

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          {loading ? (
            <p className="px-4 py-10 text-center text-sm text-slate-400">Loading…</p>
          ) : tasks.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-slate-400">
              No tasks yet — add one above.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {tasks.map((t) => {
                const isBusy = busy.has(t.id)
                return (
                  <li
                    key={t.id}
                    className={`flex items-center gap-3 px-4 py-3 transition ${isBusy ? 'opacity-50' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={!!t.done}
                      disabled={isBusy}
                      onChange={() => toggle(t)}
                      className="size-4 shrink-0 cursor-pointer rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />

                    {editingId === t.id ? (
                      <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => saveEdit(t)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveEdit(t)
                          if (e.key === 'Escape') setEditingId(null)
                        }}
                        className="flex-1 rounded border border-indigo-300 px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-indigo-200"
                      />
                    ) : (
                      <button
                        onClick={() => {
                          setEditingId(t.id)
                          setDraft(t.title)
                        }}
                        title="Click to rename"
                        className={`flex-1 truncate text-left text-sm ${
                          t.done ? 'text-slate-400 line-through' : 'text-slate-800'
                        }`}
                      >
                        {t.title}
                      </button>
                    )}

                    <time
                      className="hidden shrink-0 text-xs text-slate-400 sm:block"
                      dateTime={t.updatedAt}
                      title={`created ${t.createdAt}\nupdated ${t.updatedAt}`}
                    >
                      {new Date(t.updatedAt).toLocaleTimeString()}
                    </time>

                    <button
                      onClick={() => remove(t)}
                      disabled={isBusy}
                      title="Delete"
                      className="shrink-0 rounded p-1 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                    >
                      <svg className="size-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                        <path
                          fillRule="evenodd"
                          d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.58.177-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193V3.75A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4ZM8.58 7.72a.75.75 0 0 0-1.5.06l.3 7.5a.75.75 0 1 0 1.5-.06l-.3-7.5Zm4.34.06a.75.75 0 1 0-1.5-.06l-.3 7.5a.75.75 0 1 0 1.5.06l.3-7.5Z"
                          clipRule="evenodd"
                        />
                      </svg>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          {nextToken && (
            <button
              onClick={loadMore}
              className="w-full border-t border-slate-100 px-4 py-2.5 text-sm font-medium text-indigo-600 transition hover:bg-indigo-50"
            >
              Load more
            </button>
          )}
        </div>

        <footer className="mt-4 flex items-center justify-between px-1 text-xs text-slate-400">
          <span>
            {tasks.length} loaded · {remaining} open
          </span>
          <button onClick={() => void loadFirst()} className="hover:text-slate-600">
            refresh
          </button>
        </footer>
      </div>
    </div>
  )
}
