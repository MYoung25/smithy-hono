// Typed client for the crud-api `Task` resource (the generated zero-handler CRUD
// service). Routes/shapes mirror examples/crud-api/model/main.smithy exactly:
//   POST   /tasks            body: TaskBody          -> 201 { item }
//   GET    /tasks/{id}                               -> 200 { item } | 404 { message }
//   PUT    /tasks/{id}        body: TaskBody          -> 200 { item } | 404
//   DELETE /tasks/{id}                               -> 204 (no body) | 404
//   GET    /tasks?maxResults=&nextToken=            -> 200 { items, nextToken? }

export interface Task {
  id: string
  title: string
  done?: boolean
  createdAt: string
  updatedAt: string
}

/** The client-supplied write surface (TaskBody) — no server-managed fields. */
export interface TaskBody {
  title: string
  done?: boolean
}

export interface Page {
  items: Task[]
  nextToken?: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  const body = text ? JSON.parse(text) : undefined
  if (!res.ok) {
    // TaskNotFound / ValidationError carry `message`; the validation pipeline
    // uses `{ code, fieldErrors }`.
    const msg =
      body?.message ??
      (body?.code ? `${body.code}${body.fieldErrors ? ': ' + JSON.stringify(body.fieldErrors) : ''}` : null) ??
      `HTTP ${res.status}`
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(body))
  }
  return body as T
}

export const api = {
  list(maxResults = 5, nextToken?: string): Promise<Page> {
    const q = new URLSearchParams({ maxResults: String(maxResults) })
    if (nextToken) q.set('nextToken', nextToken)
    return request<Page>(`/tasks?${q.toString()}`)
  },
  create(body: TaskBody): Promise<{ item: Task }> {
    return request(`/tasks`, { method: 'POST', body: JSON.stringify(body) })
  },
  update(id: string, body: TaskBody): Promise<{ item: Task }> {
    return request(`/tasks/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  },
  remove(id: string): Promise<void> {
    return request(`/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
}
