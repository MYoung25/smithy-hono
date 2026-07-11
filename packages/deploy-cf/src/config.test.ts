import { describe, it, expect } from 'vitest'
import {
  deriveDurableObjects,
  realtimeHubBinding,
  REALTIME_HUB_BINDING,
  REALTIME_HUB_CLASS,
  REALTIME_HUB_MIGRATION_TAG,
} from './config.js'
import type { DeployConfig } from './config.js'

describe('deriveDurableObjects (R3-5: idempotency semantics)', () => {
  it('returns the declared list unchanged when realtimeHub is falsy (zero churn)', () => {
    const declared = [{ name: 'SECURITY_DO', className: 'SecurityDurableObject' }]
    const config: DeployConfig = {
      appName: 'demo',
      workerEntry: 'src/worker.ts',
      bindings: { durableObjects: declared },
    }
    expect(deriveDurableObjects(config)).toBe(declared)
  })

  it('injects the stock hub when realtimeHub: true and no hub is declared', () => {
    const config: DeployConfig = {
      appName: 'demo',
      workerEntry: 'src/worker.ts',
      realtimeHub: true,
      bindings: { durableObjects: [{ name: 'SECURITY_DO', className: 'SecurityDurableObject' }] },
    }
    const out = deriveDurableObjects(config)
    expect(out).toHaveLength(2)
    expect(out[1]).toEqual(realtimeHubBinding())
  })

  it('dedupes on CLASS: a declared RealtimeDurableObject under ANY binding name suppresses injection', () => {
    // Operator hand-declared the hub class but under a non-conventional binding name.
    const config: DeployConfig = {
      appName: 'demo',
      workerEntry: 'src/worker.ts',
      realtimeHub: true,
      bindings: {
        durableObjects: [{ name: 'LIVE_HUB', className: REALTIME_HUB_CLASS, migrationTag: 'v1' }],
      },
    }
    const out = deriveDurableObjects(config)
    expect(out).toHaveLength(1)
    expect(out.filter((d) => d.className === REALTIME_HUB_CLASS)).toHaveLength(1)
  })

  it('does NOT dedupe on binding NAME alone — it THROWS on a reserved-name collision', () => {
    // The old OR-match silently swallowed the realtime injection here. Now surfaced.
    const config: DeployConfig = {
      appName: 'demo',
      workerEntry: 'src/worker.ts',
      realtimeHub: true,
      bindings: {
        durableObjects: [{ name: REALTIME_HUB_BINDING, className: 'SomethingUnrelated' }],
      },
    }
    expect(() => deriveDurableObjects(config)).toThrow(/reserved for the realtime hub/)
    expect(() => deriveDurableObjects(config)).toThrow(/SomethingUnrelated/)
  })

  it('respects an operator hub declared with the conventional name + class (no throw, no dup)', () => {
    const config: DeployConfig = {
      appName: 'demo',
      workerEntry: 'src/worker.ts',
      realtimeHub: true,
      bindings: {
        durableObjects: [
          { name: REALTIME_HUB_BINDING, className: REALTIME_HUB_CLASS, migrationTag: 'v1' },
        ],
      },
    }
    const out = deriveDurableObjects(config)
    expect(out).toHaveLength(1)
    expect(out[0].migrationTag).toBe('v1') // operator's tag respected, not realtime-v1
  })

  it('realtimeHubBinding is the stock single spec (name/class/tag constants)', () => {
    expect(realtimeHubBinding()).toEqual({
      name: REALTIME_HUB_BINDING,
      className: REALTIME_HUB_CLASS,
      migrationTag: REALTIME_HUB_MIGRATION_TAG,
    })
  })
})
