/**
 * OPS-04 — health, readiness, and graceful-shutdown support.
 *
 * - {@link healthHandler} (liveness): the process is up and the event loop responds.
 *   Mount at `/healthz`. Never touches backends — a liveness probe must not fail
 *   just because a dependency is briefly down (that's readiness's job).
 * - {@link readinessHandler} (readiness): the configured backends respond. Mount at
 *   `/readyz`. Probes `stores.session`/`stores.secrets` with a sentinel READ (a
 *   `null` result still proves the backend answered) plus any custom probes; a
 *   thrown probe ⇒ 503 with the failed dependency names. Use it to gate traffic
 *   (load-balancer / k8s readiness) so a pod with a dead dependency is pulled.
 *
 * ## Graceful shutdown (per runtime)
 * - **Node** (`@hono/node-server`): on `SIGTERM`/`SIGINT`, stop accepting new
 *   connections (`server.close(cb)`), let in-flight requests drain (bound them with
 *   the OPS-04 `requestTimeoutMs`), flip readiness to 503 first so the LB drains you,
 *   then exit. A typical sequence: mark not-ready → wait a drain interval →
 *   `server.close()` → `process.exit(0)`.
 * - **Cloudflare Workers / Lambda**: shutdown/draining is platform-managed; there is
 *   no long-lived process to signal. Readiness is still useful for dependency gating.
 *
 * Web-standard only (ARCH-01): no `node:*`, no `Buffer`.
 */

import type { Context, Handler } from 'hono'
import type { SecurityConfig } from '../config.js'

/** A liveness handler — always 200 while the process can answer. */
export function healthHandler(): Handler {
  const handler: Handler = (c: Context) => c.json({ status: 'ok' }, 200)
  Object.defineProperty(handler, 'name', { value: 'healthHandler' })
  return handler
}

/** A named readiness probe. `check` throws (or rejects) when the dependency is down. */
export interface ReadinessProbe {
  name: string
  check: () => Promise<void>
}

export interface ReadinessOptions {
  /** Extra dependency probes (DB, cache, downstream) beyond the auto store probes. */
  probes?: ReadinessProbe[]
  /** Auto-probe `stores.session`/`stores.secrets` with a sentinel read. Default true. */
  probeStores?: boolean
}

/** A sentinel key used for read-only store liveness probes (never a real id). */
const PROBE_KEY = '__readiness_probe__'

/**
 * A readiness handler that probes configured backends. Returns 200
 * `{ status: 'ready' }` when every probe resolves, else 503
 * `{ status: 'not_ready', failed: [...] }` naming the failed dependencies.
 *
 * Auto store probes are READ-ONLY (`session.get`, `secrets.getSigningKey`) — a
 * `null` result still proves the backend answered. Mutating stores (nonce/rate
 * limit) are intentionally not auto-probed.
 */
export function readinessHandler(
  config: SecurityConfig,
  opts: ReadinessOptions = {},
): Handler {
  const probeStores = opts.probeStores ?? true
  const custom = opts.probes ?? []

  const handler: Handler = async (c: Context) => {
    const probes: ReadinessProbe[] = [...custom]
    if (probeStores) {
      if (config.stores.session) {
        probes.push({ name: 'session', check: () => config.stores.session!.get(PROBE_KEY).then(() => {}) })
      }
      if (config.stores.secrets) {
        probes.push({ name: 'secrets', check: () => config.stores.secrets!.getSigningKey(PROBE_KEY).then(() => {}) })
      }
    }

    const failed: string[] = []
    await Promise.all(
      probes.map(async (p) => {
        try {
          await p.check()
        } catch {
          failed.push(p.name)
        }
      }),
    )

    if (failed.length > 0) {
      return c.json({ status: 'not_ready', failed }, 503)
    }
    return c.json({ status: 'ready' }, 200)
  }
  Object.defineProperty(handler, 'name', { value: 'readinessHandler' })
  return handler
}
