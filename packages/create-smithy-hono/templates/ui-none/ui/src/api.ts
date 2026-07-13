// Typed client for the `Task` resource. Paths mirror model/main.smithy exactly:
//   POST   /tasks          body: TaskBody -> 201 { item }
//   GET    /tasks/{id}                    -> 200 { item } | 404 { message }
//   PUT    /tasks/{id}      body: TaskBody -> 200 { item } | 404
//   DELETE /tasks/{id}                     -> 204 | 404
//   GET    /tasks?maxResults=&nextToken=  -> 200 { items, nextToken? }
//
// API_BASE is '' in dev (Vite proxies /tasks to the local API) and '/api' in the
// production build (deploy sets VITE_API_BASE=/api), so the app is same-origin in
// both — no CORS.

const API_BASE = import.meta.env.VITE_API_BASE ?? ''

export interface Task {
  id: string
  title: string
  done?: boolean
  createdAt: string
  updatedAt: string
}

export interface TaskBody {
  title: string
  done?: boolean
}

export interface Page {
  items: Task[]
  nextToken?: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  const body = text ? JSON.parse(text) : undefined
  if (!res.ok) {
    const msg = body?.message ?? body?.code ?? `HTTP ${res.status}`
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(body))
  }
  return body as T
}

export const api = {
  list(maxResults = 20, nextToken?: string): Promise<Page> {
    const q = new URLSearchParams({ maxResults: String(maxResults) })
    if (nextToken) q.set('nextToken', nextToken)
    return request<Page>(`/tasks?${q.toString()}`)
  },
  create(body: TaskBody): Promise<{ item: Task }> {
    return request(`/tasks`, { method: 'POST', body: JSON.stringify(body) })
  },
  update(id: string, body: TaskBody): Promise<{ item: Task }> {
    return request(`/tasks/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) })
  },
  remove(id: string): Promise<void> {
    return request(`/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
}
