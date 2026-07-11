/**
 * crud-api end-to-end (Plan 13, P4) — proves the ZERO-HANDLER CRUD service works
 * through the REAL generated router + the generated default-impl factory, against
 * the in-memory DataStore.
 *
 * Every request goes through `createCrudApp` (the same factory `src/index.ts` boots),
 * driven via Hono's in-memory `app.request` client — no network, no Redis.
 *
 * The full lifecycle is asserted against the modeled status codes:
 *   POST   /tasks      → 201 (create, server-assigned id)
 *   GET    /tasks/{id} → 200 (read)
 *   PUT    /tasks/{id} → 200 (update; verify the change round-trips)
 *   DELETE /tasks/{id} → 204 (delete)
 *   GET    /tasks/{id} → 404 (gone)
 *   GET    /tasks      → 200 (list, opaque-cursor pagination)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createMemoryDataStore } from '@smithy-hono/data-core/memory'
import { createCrudApp } from '../src/createApp'
import type { TaskData } from '../generated/task.gen'

function makeApp() {
  return createCrudApp({ store: createMemoryDataStore<TaskData>() }).app
}

describe('crud-api zero-handler lifecycle', () => {
  let app: ReturnType<typeof makeApp>

  beforeEach(() => {
    app = makeApp()
  })

  async function create(body: { title: string; done?: boolean }) {
    const res = await app.request('/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return res
  }

  it('POST → GET → PUT → GET → DELETE → GET 404', async () => {
    // POST (create) → 201, server-assigned id, stamped timestamps.
    const createRes = await create({ title: 'write the e2e', done: false })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as { item: TaskData }
    expect(created.item.title).toBe('write the e2e')
    expect(created.item.done).toBe(false)
    expect(created.item.id).toBeTruthy()
    expect(created.item.createdAt).toBeTruthy()
    expect(created.item.updatedAt).toBeTruthy()
    const id = created.item.id

    // GET (read) → 200, same entity.
    const getRes = await app.request(`/tasks/${id}`)
    expect(getRes.status).toBe(200)
    const got = (await getRes.json()) as { item: TaskData }
    expect(got.item.id).toBe(id)
    expect(got.item.title).toBe('write the e2e')

    // PUT (update) → 200; the change round-trips.
    const putRes = await app.request(`/tasks/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'shipped the e2e', done: true }),
    })
    expect(putRes.status).toBe(200)
    const put = (await putRes.json()) as { item: TaskData }
    expect(put.item.id).toBe(id)
    expect(put.item.title).toBe('shipped the e2e')
    expect(put.item.done).toBe(true)

    // GET (verify update persisted).
    const getRes2 = await app.request(`/tasks/${id}`)
    expect(getRes2.status).toBe(200)
    const got2 = (await getRes2.json()) as { item: TaskData }
    expect(got2.item.title).toBe('shipped the e2e')
    expect(got2.item.done).toBe(true)

    // DELETE → 204 (no body).
    const delRes = await app.request(`/tasks/${id}`, { method: 'DELETE' })
    expect(delRes.status).toBe(204)
    expect(await delRes.text()).toBe('')

    // GET after delete → 404 (the modeled TaskNotFound).
    const gone = await app.request(`/tasks/${id}`)
    expect(gone.status).toBe(404)
  })

  it('GET on a never-created id → 404', async () => {
    const res = await app.request('/tasks/does-not-exist')
    expect(res.status).toBe(404)
  })

  it('PUT / DELETE on a missing id → 404', async () => {
    const putRes = await app.request('/tasks/missing', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(putRes.status).toBe(404)

    const delRes = await app.request('/tasks/missing', { method: 'DELETE' })
    expect(delRes.status).toBe(404)
  })

  it('LIST paginates with an opaque cursor', async () => {
    // Seed several tasks.
    const total = 5
    for (let i = 0; i < total; i++) {
      const res = await create({ title: `task-${i}` })
      expect(res.status).toBe(201)
    }

    // Page through with maxResults=2: expect 2 + 2 + 1, walking the opaque cursor.
    const seen = new Set<string>()
    let cursor: string | undefined
    let pages = 0

    do {
      const url = new URL('http://local/tasks')
      url.searchParams.set('maxResults', '2')
      if (cursor) url.searchParams.set('nextToken', cursor)

      const res = await app.request(url.pathname + url.search)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { items: TaskData[]; nextToken?: string }

      // The cursor is opaque — never an offset/index.
      if (body.nextToken !== undefined) {
        expect(body.nextToken).not.toMatch(/^\d+$/)
      }

      for (const t of body.items) seen.add(t.id)
      expect(body.items.length).toBeLessThanOrEqual(2)

      cursor = body.nextToken
      pages++
      expect(pages).toBeLessThanOrEqual(total + 1) // guard against an infinite loop
    } while (cursor)

    // Every seeded task surfaced exactly once across the pages.
    expect(seen.size).toBe(total)
    expect(pages).toBe(3) // 2 + 2 + 1
  })
})
