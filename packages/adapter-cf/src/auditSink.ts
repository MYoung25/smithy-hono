/**
 * Cloudflare concrete {@link AuditSink} + {@link MetricsSink} (OPS-05, LOG-08/10).
 *
 * security-core emits typed audit events (`auth.failure`, `ratelimit.trip`,
 * `key.rotate`, …) through an injected {@link AuditSink} and operational signals
 * (5xx, limiter saturation, cert expiry) through an injected {@link MetricsSink},
 * but never picks a transport (LOG-05/ARCH-01). On Workers, anything written with
 * `console.log` is captured by **Logpush** (Workers Trace Events Logpush) and
 * delivered to the configured destination (R2, an HTTP endpoint, a SIEM). So the
 * transport here is one JSON line per record via `console.log`; the JSON keeps the
 * Logpush stream queryable.
 *
 * Pointing at a real destination is a DEPLOY concern, not code: enable Logpush for
 * the Worker (a Logpush job to R2 with Object-Lock for the WORM/1yr audit baseline,
 * or to a SIEM), and route on the `kind: 'audit'` vs `kind: 'metric'` discriminator
 * this sink stamps. Optional: ship metrics to **Workers Analytics Engine** instead
 * by passing a sink that calls `writeDataPoint` — out of scope here (it needs a
 * binding), but the {@link MetricsSink} seam makes it a drop-in.
 *
 * Wrap with `new ChainedAuditSink(createConsoleAuditSink())` for the LOG-12
 * hash-chain (default off).
 *
 * Web-standard surface only (ARCH-01): the single touch-point is `console.*`,
 * exactly like the existing `createConsoleLogger` — no Cloudflare SDK import.
 */

import type { AuditEvent, AuditSink, MetricSignal, MetricsSink } from '@smithy-hono/security-core'

/** Options shared by the Cloudflare audit + metrics sinks. */
export interface ConsoleSinkOptions {
  /** Static fields merged into every line (e.g. `{ service: 'todo-api' }`). */
  base?: Record<string, unknown>
}

/**
 * Create a Cloudflare {@link AuditSink} that writes one JSON line per audit event
 * via `console.log` → Logpush. Each line carries `kind: 'audit'` (so a Logpush
 * job / downstream consumer can route audit records to a WORM/long-retention
 * destination distinctly from request logs, LOG-06) plus the verbatim event —
 * including the `seq/prevHash/hash` chain fields when wrapped in
 * `ChainedAuditSink`. `principalRef` is already pseudonymized (LOG-11); core only
 * passes sanitized, PII-free events.
 */
export function createConsoleAuditSink(opts: ConsoleSinkOptions = {}): AuditSink {
  const base = opts.base ?? {}
  return {
    emit(event: AuditEvent): Promise<void> {
      console.log(JSON.stringify({ kind: 'audit', ...base, ...event }))
      return Promise.resolve()
    },
  }
}

/**
 * Create a Cloudflare {@link MetricsSink} (LOG-08) that writes one JSON line per
 * operational signal via `console.log` → Logpush, tagged `kind: 'metric'`. A
 * downstream pipeline turns these into a `http.5xx` rate, a `ratelimit.saturation`
 * rate, and a `cert.expiry` gauge to alert on. Fire-and-forget per the
 * {@link MetricsSink} contract.
 */
export function createConsoleMetricsSink(opts: ConsoleSinkOptions = {}): MetricsSink {
  const base = opts.base ?? {}
  return {
    emit(signal: MetricSignal): void {
      console.log(JSON.stringify({ kind: 'metric', ...base, ...signal }))
    },
  }
}
