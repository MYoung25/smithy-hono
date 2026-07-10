import { describe, it, expect } from 'vitest'
import {
  buildMetricSignal,
  emitMetric,
  emitRateLimitSaturation,
  emitFiveXx,
  emitCertExpiry,
} from './metrics.js'
import type { MetricSignal, MetricsSink } from './metrics.js'

/** A capturing metrics sink that records every emitted signal in order. */
function captureSink(): MetricsSink & { signals: MetricSignal[] } {
  const signals: MetricSignal[] = []
  return { signals, emit: (s) => signals.push(s) }
}

describe('buildMetricSignal (LOG-08)', () => {
  it('stamps an RFC3339 ts and the supplied fields', () => {
    const s = buildMetricSignal({
      type: 'http.5xx',
      value: 1,
      unit: 'count',
      labels: { status: 503 },
    })
    expect(s.type).toBe('http.5xx')
    expect(s.value).toBe(1)
    expect(s.unit).toBe('count')
    expect(s.labels).toEqual({ status: 503 })
    expect(Number.isNaN(Date.parse(s.ts))).toBe(false)
    expect(s.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('omits labels when not supplied', () => {
    const s = buildMetricSignal({ type: 'cert.expiry', value: 0, unit: 'seconds' })
    expect('labels' in s).toBe(false)
  })
})

describe('emitMetric', () => {
  it('is a no-op when the sink is undefined (metrics off)', () => {
    expect(() =>
      emitMetric(undefined, buildMetricSignal({ type: 'http.5xx', value: 1, unit: 'count' })),
    ).not.toThrow()
  })

  it('delivers to the sink', () => {
    const sink = captureSink()
    emitMetric(sink, buildMetricSignal({ type: 'http.5xx', value: 1, unit: 'count' }))
    expect(sink.signals).toHaveLength(1)
    expect(sink.signals[0]!.type).toBe('http.5xx')
  })

  it('swallows a throwing sink and surfaces via the logger', () => {
    const errors: Record<string, unknown>[] = []
    const logger = {
      info: () => {},
      warn: () => {},
      error: (r: Record<string, unknown>) => errors.push(r),
    }
    const sink: MetricsSink = {
      emit: () => {
        throw new Error('boom')
      },
    }
    expect(() =>
      emitMetric(sink, buildMetricSignal({ type: 'http.5xx', value: 1, unit: 'count' }), logger),
    ).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(errors[0]!['msg']).toBe('metrics sink emit failed')
  })

  it('falls back to console.error when no logger is provided (AUDIT-LOGGING-05)', () => {
    const calls: unknown[][] = []
    const original = console.error
    console.error = (...args: unknown[]) => {
      calls.push(args)
    }
    try {
      const sink: MetricsSink = {
        emit: () => {
          throw new Error('boom')
        },
      }
      expect(() =>
        emitMetric(sink, buildMetricSignal({ type: 'http.5xx', value: 1, unit: 'count' })),
      ).not.toThrow()
      expect(calls).toHaveLength(1)
      expect(calls[0]![0]).toMatchObject({ msg: 'metrics sink emit failed', type: 'http.5xx' })
    } finally {
      console.error = original
    }
  })
})

describe('LOG-08 convenience emitters', () => {
  it('ratelimit.saturation carries scope/op/back-off and no PII', () => {
    const sink = captureSink()
    emitRateLimitSaturation(sink, { scope: 'principal', operation: 'GetTodo', retryAfterSeconds: 3 })
    const s = sink.signals[0]!
    expect(s.type).toBe('ratelimit.saturation')
    expect(s.value).toBe(1)
    expect(s.unit).toBe('count')
    expect(s.labels).toEqual({ scope: 'principal', operation: 'GetTodo', retryAfterSeconds: 3 })
  })

  it('http.5xx counts a single 5xx with its status', () => {
    const sink = captureSink()
    emitFiveXx(sink, { status: 500 })
    const s = sink.signals[0]!
    expect(s.type).toBe('http.5xx')
    expect(s.value).toBe(1)
    expect(s.labels).toEqual({ status: 500 })
  })

  it('cert.expiry is a seconds-remaining gauge labeled by subject', () => {
    const sink = captureSink()
    emitCertExpiry(sink, { subject: 'api.example.com', secondsRemaining: -42 })
    const s = sink.signals[0]!
    expect(s.type).toBe('cert.expiry')
    expect(s.value).toBe(-42)
    expect(s.unit).toBe('seconds')
    expect(s.labels).toEqual({ subject: 'api.example.com' })
  })

  it('all emitters are no-ops with an undefined sink', () => {
    expect(() => {
      emitRateLimitSaturation(undefined, { scope: 'ip' })
      emitFiveXx(undefined, { status: 502 })
      emitCertExpiry(undefined, { subject: 'x', secondsRemaining: 1 })
    }).not.toThrow()
  })
})
