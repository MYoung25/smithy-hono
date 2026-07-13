/**
 * End-to-end test over the generated router + default CRUD impl. Runs after
 * `npm run codegen` (which emits src/generated/*). Builds the app with a fresh
 * in-memory store per test, exactly as the deploy entries build it with a durable
 * store.
 */
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/createApp'

describe('Task CRUD', () => {
  it('creates then lists a task', async () => {
    const { app } = createApp()

    const created = await app.request('/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'write the model' }),
    })
    expect(created.status).toBe(201)
    const { item } = (await created.json()) as { item: { id: string; title: string } }
    expect(item.title).toBe('write the model')

    const listed = await app.request('/tasks')
    expect(listed.status).toBe(200)
    const page = (await listed.json()) as { items: unknown[] }
    expect(page.items).toHaveLength(1)
  })

  it('answers the health probe', async () => {
    const { app } = createApp()
    const res = await app.request('/healthz')
    expect(res.status).toBe(200)
  })
})
