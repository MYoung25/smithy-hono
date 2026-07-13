import { useEffect, useState } from 'react'
import { api, type Task } from './api'

export function App() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    try {
      const page = await api.list()
      setTasks(page.items)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    await api.create({ title: title.trim() })
    setTitle('')
    await refresh()
  }

  async function toggle(t: Task) {
    await api.update(t.id, { title: t.title, done: !t.done })
    await refresh()
  }

  async function remove(t: Task) {
    await api.remove(t.id)
    await refresh()
  }

  return (
    <main>
      <h1>{{APP_NAME}}</h1>
      <form onSubmit={add}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New task…"
          aria-label="New task"
        />
        <button type="submit">Add</button>
      </form>
      {error && <p className="error">Error: {error}</p>}
      <ul>
        {tasks.map((t) => (
          <li key={t.id}>
            <label>
              <input type="checkbox" checked={!!t.done} onChange={() => toggle(t)} />
              <span className={t.done ? 'done' : ''}>{t.title}</span>
            </label>
            <button onClick={() => remove(t)} aria-label={`Delete ${t.title}`}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      {tasks.length === 0 && !error && <p className="empty">No tasks yet — add one above.</p>}
    </main>
  )
}
