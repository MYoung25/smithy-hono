/**
 * Node concrete {@link AuditSink} + {@link MetricsSink} (OPS-05, LOG-08/10).
 *
 * security-core emits typed audit events (`auth.failure`, `ratelimit.trip`,
 * `key.rotate`, …) through an injected {@link AuditSink}, and operational signals
 * (5xx, limiter saturation, cert expiry) through an injected {@link MetricsSink},
 * but core never picks a transport (LOG-05/ARCH-01). This is the Node transport:
 * one JSON line per record to stdout via `console.log` — the Node convention where
 * a log shipper (Fluent Bit / Vector / the container runtime / k8s) tails stdout
 * and forwards structured lines to a collector (Loki, Elasticsearch, a SIEM).
 *
 * Shipping to a real destination is a DEPLOY concern, not code: point the
 * container's stdout collector at the destination, and route by the discriminator
 * field this sink stamps — `kind: 'audit'` vs `kind: 'metric'` — into separate
 * indices/streams with their own retention (default 1yr audit / 90d request; see
 * the package README). A trivial file/syslog variant is left to the collector
 * rather than re-implemented here (no `node:fs`/`node:dgram` in the adapter keeps
 * this dependency-free and matches how `createStdoutLogger` already works).
 *
 * Wrap with `new ChainedAuditSink(createStdoutAuditSink())` to add the LOG-12
 * hash-chain (default off); the chain stamps `seq/prevHash/hash` then delegates
 * here.
 *
 * Web-standard surface only: the single Node touch-point is `console.log` (ambient
 * via the DOM lib), exactly like the existing stdout logger — no `node:*` import.
 */

import type { AuditEvent, AuditSink, MetricSignal, MetricsSink } from '@smithy-hono/security-core'

/** Minimal structural console (no @types/node; `console.log` is ambient via DOM lib). */
interface ConsoleLike {
  log(line: string): void
}

declare const console: ConsoleLike

/** Options shared by the Node audit + metrics sinks. */
export interface StdoutSinkOptions {
  /** Static fields merged into every line (e.g. `{ service: 'todo-api', env: 'prod' }`). */
  base?: Record<string, unknown>
}

/**
 * Create a Node {@link AuditSink} that writes one JSON line per audit event to
 * stdout (`console.log`). Each line carries `kind: 'audit'` (so a collector can
 * route audit records to a WORM/long-retention index distinctly from request logs,
 * LOG-06) plus the verbatim event — `type`, `ts`, `requestId`, `principalRef`
 * (already pseudonymized, LOG-11), `outcome`, and any `detail`, including the
 * `seq/prevHash/hash` chain fields when wrapped in `ChainedAuditSink`. Core only
 * passes sanitized, PII-free events, so the whole event is safe to serialize.
 *
 * `emit` resolves immediately: `console.log` is synchronous, but the method is
 * async to satisfy the {@link AuditSink} contract (and `emitAudit` already isolates
 * a throw, so a serialization failure never reaches the request path).
 */
export function createStdoutAuditSink(opts: StdoutSinkOptions = {}): AuditSink {
  const base = opts.base ?? {}
  return {
    emit(event: AuditEvent): Promise<void> {
      console.log(JSON.stringify({ kind: 'audit', ...base, ...event }))
      return Promise.resolve()
    },
  }
}

/**
 * Create a Node {@link MetricsSink} (LOG-08) that writes one JSON line per
 * operational signal to stdout (`console.log`), tagged `kind: 'metric'`. A metrics
 * pipeline (a stdout-scraping exporter, Vector's `log_to_metric` transform, or a
 * collector rule) converts these into counters/gauges and alerts: a `http.5xx`
 * RATE, a `ratelimit.saturation` rate, and a `cert.expiry` gauge threshold.
 * Fire-and-forget per the {@link MetricsSink} contract.
 */
export function createStdoutMetricsSink(opts: StdoutSinkOptions = {}): MetricsSink {
  const base = opts.base ?? {}
  return {
    emit(signal: MetricSignal): void {
      console.log(JSON.stringify({ kind: 'metric', ...base, ...signal }))
    },
  }
}
