/**
 * AWS concrete {@link AuditSink} + {@link MetricsSink} (OPS-05, LOG-08/10).
 *
 * security-core emits typed audit events (`auth.failure`, `ratelimit.trip`,
 * `key.rotate`, …) through an injected {@link AuditSink} and operational signals
 * (5xx, limiter saturation, cert expiry) through an injected {@link MetricsSink},
 * but never picks a transport (LOG-05/ARCH-01). On Lambda, anything written to
 * `console.*` (stdout/stderr) is captured by **CloudWatch Logs**; emitting JSON
 * makes the records queryable with CloudWatch Logs Insights. So the transport here
 * is one JSON line per record via `console.log`.
 *
 * Pointing at a real destination is a DEPLOY concern, not code: a CloudWatch Logs
 * **subscription filter** fans the lines to a destination — Kinesis Data Streams /
 * Firehose → S3 (with **Object-Lock** for the WORM/1yr audit baseline) or a SIEM —
 * routed by the `kind: 'audit'` vs `kind: 'metric'` discriminator this sink stamps.
 * Optional: emit metrics as **CloudWatch EMF** (embedded-metric JSON) so CloudWatch
 * auto-extracts metrics from the log line — a drop-in alternate `MetricsSink` that
 * formats the EMF envelope; left to the deployment.
 *
 * Wrap with `new ChainedAuditSink(createConsoleAuditSink())` for the LOG-12
 * hash-chain (default off).
 *
 * Web-standard surface only (ARCH-01): the single touch-point is an injectable
 * `console`-like object (defaulting to the ambient `console`), mirroring this
 * package's `createConsoleLogger` so tests can capture lines — no `node:*` import.
 */

import type { AuditEvent, AuditSink, MetricSignal, MetricsSink } from '@smithy-hono/security-core'

/** The minimal console surface these sinks write to (one method: `log`). */
export type LogSink = Pick<typeof console, 'log'>

/** Options shared by the AWS audit + metrics sinks. */
export interface ConsoleSinkOptions {
  /** Static fields merged into every line (e.g. `{ service: 'todo-api' }`). */
  base?: Record<string, unknown>
  /** The console-like sink to write to. Defaults to the ambient `console`. */
  sink?: LogSink
}

/**
 * Create an AWS {@link AuditSink} that writes one JSON line per audit event via
 * `console.log` → CloudWatch. Each line carries `kind: 'audit'` (so a subscription
 * filter can route audit records to a WORM/long-retention destination distinctly
 * from request logs, LOG-06) plus the verbatim event — including the
 * `seq/prevHash/hash` chain fields when wrapped in `ChainedAuditSink`.
 * `principalRef` is already pseudonymized (LOG-11); core only passes sanitized,
 * PII-free events.
 */
export function createConsoleAuditSink(opts: ConsoleSinkOptions = {}): AuditSink {
  const base = opts.base ?? {}
  const sink: LogSink = opts.sink ?? console
  return {
    emit(event: AuditEvent): Promise<void> {
      sink.log(JSON.stringify({ kind: 'audit', ...base, ...event }))
      return Promise.resolve()
    },
  }
}

/**
 * Create an AWS {@link MetricsSink} (LOG-08) that writes one JSON line per
 * operational signal via `console.log` → CloudWatch, tagged `kind: 'metric'`. A
 * metric filter / Logs Insights query (or EMF, see the module note) turns these
 * into a `http.5xx` rate, a `ratelimit.saturation` rate, and a `cert.expiry` gauge
 * to alarm on. Fire-and-forget per the {@link MetricsSink} contract.
 */
export function createConsoleMetricsSink(opts: ConsoleSinkOptions = {}): MetricsSink {
  const base = opts.base ?? {}
  const sink: LogSink = opts.sink ?? console
  return {
    emit(signal: MetricSignal): void {
      sink.log(JSON.stringify({ kind: 'metric', ...base, ...signal }))
    },
  }
}
