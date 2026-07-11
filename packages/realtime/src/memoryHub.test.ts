import { describe, it, expect } from 'vitest'
import { createMemoryHub } from './memoryHub.js'
import { runRealtimeHubConformance } from './conformance.js'

// The in-memory fan-out hub is the reference fan-out backend — run it through
// the shared conformance suite (delivery, isolation, unsubscribe, best-effort).
runRealtimeHubConformance(() => createMemoryHub(), 'createMemoryHub')

describe('createMemoryHub specifics', () => {
  it('re-subscribing after the channel drained still delivers', async () => {
    const hub = createMemoryHub()
    // Subscribe then unsubscribe so the channel set empties (and is GC'd).
    const off = hub.subscribe('game:1', () => {})
    off()
    // A fresh subscriber on the same (now-recreated) channel must still work.
    const received: unknown[] = []
    hub.subscribe('game:1', (e) => received.push(e))
    await hub.notify('game:1', { type: 'game:updated', data: { version: 1 } })
    expect(received).toHaveLength(1)
  })

  it('delivers synchronously within the notify() promise', async () => {
    const hub = createMemoryHub()
    let delivered = false
    hub.subscribe('game:1', () => {
      delivered = true
    })
    const p = hub.notify('game:1', { type: 'x', data: null })
    // Memory fan-out is synchronous, so the subscriber has already run.
    expect(delivered).toBe(true)
    await p
  })
})
