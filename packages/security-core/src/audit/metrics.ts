/**
 * Operational signals (LOG-08) — structured metric records.
 *
 * LOG-08 requires that operational failures be observable: error/5xx rates,
 * rate-limit saturation, and certificate expiry (TLS-05). Like the request
 * {@link Logger} and the {@link AuditSink}, core does NOT pick a metrics backend
 * (Prometheus, StatsD, CloudWatch EMF, Workers Analytics Engine): it emits a
 * typed, structured signal record through an INJECTED {@link MetricsSink}, and
 * the deployment decides where it goes — usually the same console/Logpush/
 * CloudWatch stream the logger uses, scraped or alerted on downstream.
 *
 * Web-standard only (ARCH-01): this module declares types and pure builders +
 * a best-effort emitter; it constructs no transport, reads no env, and uses no
 * `node:*`. The concrete sink is supplied by the adapter (or an app), exactly
 * like the request logger.
 *
 * The three LOG-08 signals:
 *   - `ratelimit.saturation` — a limiter bucket denied a request (it is
 *     saturated / out of tokens). Emitted at-source in the limiter alongside the
 *     `ratelimit.trip` audit event, but as a METRIC (countable, alertable on a
 *     rate) rather than an audit record.
 *   - `http.5xx` — the server returned a 5xx. Emitted per-occurrence; a backend
 *     aggregates these into a 5xx-rate / spike alert.
 *   - `cert.expiry` — a certificate's remaining validity. A documented HOOK
 *     ({@link emitCertExpiry}) a deployment's probe calls on a schedule; core
 *     cannot read a TLS cert itself (terminated at the edge / platform), so this
 *     is emitted by deploy-side glue, not the request path.
 */

import type { Logger } from '../config.js'

// ---------------------------------------------------------------------------
// Signal types (LOG-08).
// ---------------------------------------------------------------------------

/** The typed, versioned operational-signal categories (LOG-08). */
export type MetricSignalType =
  | 'ratelimit.saturation'
  | 'http.5xx'
  | 'cert.expiry'

/**
 * A structured operational signal (LOG-08). `name` is the signal type, `value`
 * a numeric measurement (a count delta — usually `1` for a per-occurrence event —
 * or a gauge such as seconds-until-expiry), and `unit` describes what `value`
 * means so a backend can chart/alert on it correctly. `labels` are low-cardinality
 * dimensions (LOG-06: never PII, never high-cardinality like a raw IP/principal).
 */
export interface MetricSignal {
  type: MetricSignalType
  /** RFC3339 timestamp. */
  ts: string
  /** Numeric measurement — a counter delta or a gauge reading. */
  value: number
  /** What `value` measures: `'count'` for counters, or a gauge unit (e.g. `'seconds'`). */
  unit: 'count' | 'seconds'
  /** Low-cardinality dimensions (LOG-06) — never PII/high-cardinality. */
  labels?: Record<string, string | number>
}

/**
 * Injected metrics destination (ARCH-05), the LOG-08 sibling of {@link AuditSink}
 * / {@link Logger}. Core only calls {@link emit} with sanitized, low-cardinality
 * records; the transport (console/Logpush/CloudWatch EMF/Analytics Engine) is a
 * deployment concern. `emit` is fire-and-forget (`void`, not `Promise`): a signal
 * must never add latency to or throw into the request path.
 */
export interface MetricsSink {
  emit(signal: MetricSignal): void
}

// ---------------------------------------------------------------------------
// Builders (pure) — stamp `ts` from a reliable per-request clock (LOG-09).
// ---------------------------------------------------------------------------

/** Inputs to {@link buildMetricSignal} — the at-source caller supplies these. */
export interface MetricSignalInput {
  type: MetricSignalType
  value: number
  unit: 'count' | 'seconds'
  labels?: Record<string, string | number>
}

/**
 * Stamp a well-formed {@link MetricSignal}, setting `ts` to an RFC3339 timestamp
 * (`Date.now()` — always available; LOG-09). Pure and synchronous so a middleware
 * can build the signal inline the instant a condition is detected.
 */
export function buildMetricSignal(input: MetricSignalInput): MetricSignal {
  const signal: MetricSignal = {
    type: input.type,
    ts: new Date(Date.now()).toISOString(),
    value: input.value,
    unit: input.unit,
  }
  if (input.labels !== undefined) signal.labels = input.labels
  return signal
}

// ---------------------------------------------------------------------------
// Best-effort emission — never throws into the request path.
// ---------------------------------------------------------------------------

/**
 * Deliver `signal` to `sink` best-effort. A no-op when `sink` is undefined
 * (metrics off), and it NEVER throws into the request path — a metrics-sink
 * failure must not turn a successful request into a 500. A passed `logger`
 * surfaces the swallowed failure; when none is provided the failure still produces
 * a `console.error` diagnostic so a dropped signal is never lost silently.
 */
export function emitMetric(
  sink: MetricsSink | undefined,
  signal: MetricSignal,
  logger?: Logger,
): void {
  if (!sink) return
  try {
    sink.emit(signal)
  } catch (err) {
    const record = {
      msg: 'metrics sink emit failed',
      type: signal.type,
      err: err instanceof Error ? err.message : String(err),
    }
    if (logger) logger.error(record)
    else console.error(record)
  }
}

// ---------------------------------------------------------------------------
// LOG-08 convenience emitters (documented signal SHAPES).
// ---------------------------------------------------------------------------

/**
 * Emit a `ratelimit.saturation` signal (LOG-08): a limiter bucket is out of
 * tokens and denied a request. `scope` is the bucket family (`'ip'` |
 * `'principal'`), `operation` the modeled op name when known. Counter (`value: 1`),
 * so a backend alerts on a saturation RATE. Carries no raw IP/principal (LOG-06).
 */
export function emitRateLimitSaturation(
  sink: MetricsSink | undefined,
  args: { scope: 'ip' | 'principal'; operation?: string; retryAfterSeconds?: number },
  logger?: Logger,
): void {
  const labels: Record<string, string | number> = { scope: args.scope }
  if (args.operation !== undefined) labels['operation'] = args.operation
  if (args.retryAfterSeconds !== undefined) labels['retryAfterSeconds'] = args.retryAfterSeconds
  emitMetric(sink, buildMetricSignal({ type: 'ratelimit.saturation', value: 1, unit: 'count', labels }), logger)
}

/**
 * Emit an `http.5xx` signal (LOG-08) for a single 5xx response. Counter
 * (`value: 1`); a backend aggregates these into a 5xx-rate / spike alert. `status`
 * is the concrete 5xx code; `operation` the modeled op when known.
 */
export function emitFiveXx(
  sink: MetricsSink | undefined,
  args: { status: number; operation?: string },
  logger?: Logger,
): void {
  const labels: Record<string, string | number> = { status: args.status }
  if (args.operation !== undefined) labels['operation'] = args.operation
  emitMetric(sink, buildMetricSignal({ type: 'http.5xx', value: 1, unit: 'count', labels }), logger)
}

/**
 * Emit a `cert.expiry` signal (LOG-08 / TLS-05): a GAUGE of seconds remaining
 * until a certificate expires (negative once expired). This is the documented
 * HOOK — core cannot read a TLS cert (it is terminated at the platform/edge), so
 * a deployment's scheduled probe (a Worker cron, a Lambda scheduled event, a k8s
 * CronJob) computes the remaining validity and calls this; a backend then alerts
 * when the gauge drops below a threshold. `subject` labels which cert (host/name).
 */
export function emitCertExpiry(
  sink: MetricsSink | undefined,
  args: { subject: string; secondsRemaining: number },
  logger?: Logger,
): void {
  emitMetric(
    sink,
    buildMetricSignal({
      type: 'cert.expiry',
      value: args.secondsRemaining,
      unit: 'seconds',
      labels: { subject: args.subject },
    }),
    logger,
  )
}
