import { describe, it, expect } from 'vitest'
import { renderWrangler, orderMigrationTags, migrationGeneration } from './wrangler.js'
import type { DeployConfig } from './config.js'

/** Extract the ordered list of migration tags from a rendered wrangler.toml. */
function migrationTagOrder(toml: string): string[] {
  return [...toml.matchAll(/^tag = "([^"]+)"$/gm)].map((m) => m[1])
}

/** A representative full-stack config: assets + KV + DO (+ D1) + secrets + vars. */
function makeConfig(): DeployConfig {
  return {
    appName: 'demo',
    workerEntry: 'src/worker.ts',
    assets: {
      dir: 'web/dist',
      apiPrefix: '/api',
      spa: true,
      buildCommand: 'npm run build',
    },
    bindings: {
      kv: [{ binding: 'SESSIONS' }],
      durableObjects: [{ name: 'SECURITY_DO', className: 'SecurityDurableObject' }],
      d1: [{ binding: 'DB', databaseName: 'demo-db' }],
    },
    secrets: [{ name: 'HMAC_KEY', generate: 'hmac-hex' }],
    vars: ({ domain }) => ({
      OIDC_REDIRECT_URI: `https://${domain}/api/auth/callback`,
      ALLOWED_ORIGINS: `https://${domain}`,
    }),
  }
}

const ctxBase = {
  accountId: 'a'.repeat(32),
  domain: 'app.example.com',
  kvIds: { SESSIONS: 'b'.repeat(32) },
  d1Ids: { DB: '11111111-1111-1111-1111-111111111111' },
}

describe('renderWrangler', () => {
  it('renders all load-bearing sections', () => {
    const config = makeConfig()
    const vars = config.vars!({ domain: ctxBase.domain, apiPrefix: '/api' })
    const out = renderWrangler(config, { ...ctxBase, vars })

    expect(out).toContain('custom_domain = true')
    expect(out).toContain('app.example.com')
    expect(out).toContain('run_worker_first = ["/api/*"]')
    expect(out).toContain('not_found_handling = "single-page-application"')
    expect(out).toContain('b'.repeat(32)) // kv id
    expect(out).toContain('[[durable_objects.bindings]]')
    expect(out).toContain('class_name = "SecurityDurableObject"')
    expect(out).toContain('[[migrations]]')
    expect(out).toContain('new_classes = ["SecurityDurableObject"]')
    expect(out).toContain('[vars]')
    expect(out).toContain('OIDC_REDIRECT_URI')
    expect(out).toContain('account_id')
  })

  it('throws when a kv binding has no provisioned id', () => {
    const config = makeConfig()
    expect(() =>
      renderWrangler(config, { ...ctxBase, kvIds: {}, vars: {} }),
    ).toThrow(/missing provisioned KV id/)
  })

  it('does NOT render the realtime hub when realtimeHub is not set (no churn)', () => {
    const config = makeConfig()
    const out = renderWrangler(config, { ...ctxBase, vars: {} })
    expect(out).not.toContain('REALTIME_HUB')
    expect(out).not.toContain('RealtimeDurableObject')
  })

  it('derives the realtime hub DO binding + migration when realtimeHub: true', () => {
    const config = { ...makeConfig(), realtimeHub: true }
    const out = renderWrangler(config, { ...ctxBase, vars: {} })

    // ONE binding named REALTIME_HUB → class RealtimeDurableObject.
    expect(out).toContain('name = "REALTIME_HUB"')
    expect(out).toContain('class_name = "RealtimeDurableObject"')
    // Its own migration block, and it MUST be new_classes (stateless hub), not sqlite.
    expect(out).toContain('tag = "realtime-v1"')
    expect(out).toContain('new_classes = ["RealtimeDurableObject"]')
    expect(out).not.toContain('new_sqlite_classes')
    // The operator's existing DO still renders too (additive, no churn).
    expect(out).toContain('class_name = "SecurityDurableObject"')
  })

  it('renders the realtime hub even for an API-only config with no other DOs', () => {
    const config: DeployConfig = {
      appName: 'live-only',
      workerEntry: 'src/worker.ts',
      realtimeHub: true,
    }
    const out = renderWrangler(config, { ...ctxBase, kvIds: {}, d1Ids: {}, vars: {} })
    expect(out).toContain('name = "REALTIME_HUB"')
    expect(out).toContain('new_classes = ["RealtimeDurableObject"]')
  })

  it('does not duplicate an operator-declared realtime hub binding (idempotent)', () => {
    const config: DeployConfig = {
      appName: 'demo',
      workerEntry: 'src/worker.ts',
      realtimeHub: true,
      bindings: {
        durableObjects: [
          // Operator hand-declared the hub (e.g. with a custom migration tag).
          { name: 'REALTIME_HUB', className: 'RealtimeDurableObject', migrationTag: 'v1' },
        ],
      },
    }
    const out = renderWrangler(config, { ...ctxBase, kvIds: {}, d1Ids: {}, vars: {} })
    const bindingCount = out.split('name = "REALTIME_HUB"').length - 1
    const classCount = out.split('class_name = "RealtimeDurableObject"').length - 1
    expect(bindingCount).toBe(1)
    expect(classCount).toBe(1)
    // The operator's tag is respected — no injected realtime-v1 block.
    expect(out).not.toContain('realtime-v1')
  })
})

describe('migration ordering (R3-1: append-only-stable)', () => {
  const ctx = { ...ctxBase, kvIds: {}, d1Ids: {}, vars: {} }

  it('migrationGeneration reads the trailing integer (base gen defaults to 1)', () => {
    expect(migrationGeneration('v1')).toBe(1)
    expect(migrationGeneration('realtime-v1')).toBe(1)
    expect(migrationGeneration('billing-v2')).toBe(2)
    expect(migrationGeneration('v10')).toBe(10)
    expect(migrationGeneration('security')).toBe(1) // no digits → base generation
  })

  it('renders realtime-v1 AFTER the operator base tag but BEFORE a later-added DO', () => {
    // The 3-step break: (1) SECURITY_DO @ v1 applied, (2) adopt realtime → applied
    // [v1, realtime-v1], (3) later add BILLING_DO @ v2. Binding-array order would
    // render [v1, v2, realtime-v1] (realtime floats to the end), corrupting the
    // already-applied chain. The stable order must keep realtime-v1 in its adopted
    // slot so BILLING_DO's v2 migration renders AFTER it and still gets applied.
    const config: DeployConfig = {
      appName: 'demo',
      workerEntry: 'src/worker.ts',
      realtimeHub: true,
      bindings: {
        durableObjects: [
          { name: 'SECURITY_DO', className: 'SecurityDurableObject', migrationTag: 'v1' },
          { name: 'BILLING_DO', className: 'BillingDurableObject', migrationTag: 'v2' },
        ],
      },
    }
    const out = renderWrangler(config, ctx)

    expect(migrationTagOrder(out)).toEqual(['v1', 'realtime-v1', 'v2'])

    // Concretely: realtime-v1 must never be the last migration block once a v2 DO
    // exists (that is exactly what would strand BillingDurableObject).
    const idxRealtime = out.indexOf('tag = "realtime-v1"')
    const idxV2 = out.indexOf('tag = "v2"')
    expect(idxRealtime).toBeGreaterThan(-1)
    expect(idxV2).toBeGreaterThan(idxRealtime)
  })

  it('is prefix-stable across the 3 deploy steps (step N order ⊑ step N+1)', () => {
    const base = (dos: DeployConfig['bindings']): DeployConfig => ({
      appName: 'demo',
      workerEntry: 'src/worker.ts',
      realtimeHub: true,
      bindings: dos,
    })
    // Step 1: only the operator DO (realtime not yet adopted → set flag off).
    const step1 = renderWrangler(
      { ...base({ durableObjects: [{ name: 'SECURITY_DO', className: 'SecurityDurableObject', migrationTag: 'v1' }] }), realtimeHub: false },
      ctx,
    )
    // Step 2: adopt realtime.
    const step2 = renderWrangler(
      base({ durableObjects: [{ name: 'SECURITY_DO', className: 'SecurityDurableObject', migrationTag: 'v1' }] }),
      ctx,
    )
    // Step 3: add a new operator DO on a higher generation tag.
    const step3 = renderWrangler(
      base({
        durableObjects: [
          { name: 'SECURITY_DO', className: 'SecurityDurableObject', migrationTag: 'v1' },
          { name: 'BILLING_DO', className: 'BillingDurableObject', migrationTag: 'v2' },
        ],
      }),
      ctx,
    )
    const o1 = migrationTagOrder(step1)
    const o2 = migrationTagOrder(step2)
    const o3 = migrationTagOrder(step3)
    expect(o1).toEqual(['v1'])
    expect(o2).toEqual(['v1', 'realtime-v1'])
    expect(o3).toEqual(['v1', 'realtime-v1', 'v2'])
    // Each step's tag sequence is a prefix of the next → only ever appends → the
    // account never sees an already-applied tag reordered before a new one.
    expect(o2.slice(0, o1.length)).toEqual(o1)
    expect(o3.slice(0, o2.length)).toEqual(o2)
  })

  it('orderMigrationTags: realtime sorts after same-gen operator tags, before higher gens', () => {
    const first = new Map<string, number>([
      ['v2', 0],
      ['realtime-v1', 1],
      ['v1', 2],
    ])
    expect(orderMigrationTags(['v2', 'realtime-v1', 'v1'], first)).toEqual([
      'v1',
      'realtime-v1',
      'v2',
    ])
  })
})
