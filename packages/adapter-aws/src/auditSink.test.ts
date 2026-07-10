import { describe, it, expect } from 'vitest'
import { ChainedAuditSink, type AuditEvent } from '@smithy-hono/security-core'
import { createConsoleAuditSink, createConsoleMetricsSink } from './auditSink.js'

/** A capturing console-like sink that records every line written. */
function captureSink(): { log: (s: string) => void; lines: string[] } {
  const lines: string[] = []
  return { lines, log: (s: string) => lines.push(s) }
}

function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    type: 'auth.failure',
    ts: '2026-06-15T00:00:00.000Z',
    requestId: 'req-1',
    principalRef: 'ref-abc',
    outcome: 'deny',
    ...overrides,
  }
}

describe('createConsoleAuditSink (AWS → CloudWatch)', () => {
  it('serializes an audit event to one JSON line tagged kind=audit', async () => {
    const sink = captureSink()
    const audit = createConsoleAuditSink({ sink, base: { service: 'todo-api' } })
    await audit.emit(event({ detail: { reason: 'bad cookie' } }))
    expect(sink.lines).toHaveLength(1)
    const parsed = JSON.parse(sink.lines[0]!)
    expect(parsed).toMatchObject({
      kind: 'audit',
      service: 'todo-api',
      type: 'auth.failure',
      requestId: 'req-1',
      principalRef: 'ref-abc',
      outcome: 'deny',
      detail: { reason: 'bad cookie' },
    })
  })

  it('emits a key.rotate event through the sink (OPS-03 forward-compat)', async () => {
    const sink = captureSink()
    const audit = createConsoleAuditSink({ sink })
    await audit.emit(event({ type: 'key.rotate', principalRef: null, outcome: 'allow', detail: { keyId: 'k2' } }))
    const parsed = JSON.parse(sink.lines[0]!)
    expect(parsed.type).toBe('key.rotate')
    expect(parsed.detail).toEqual({ keyId: 'k2' })
  })

  it('passes through the LOG-12 chain fields when wrapped in ChainedAuditSink', async () => {
    const sink = captureSink()
    const chained = new ChainedAuditSink(createConsoleAuditSink({ sink }))
    await chained.emit(event())
    const parsed = JSON.parse(sink.lines[0]!)
    expect(parsed.seq).toBe(0)
    expect(typeof parsed.hash).toBe('string')
    expect(parsed.hash).toHaveLength(64)
  })
})

describe('createConsoleMetricsSink (AWS → CloudWatch)', () => {
  it('serializes a metric signal to one JSON line tagged kind=metric', () => {
    const sink = captureSink()
    const metrics = createConsoleMetricsSink({ sink })
    metrics.emit({
      type: 'http.5xx',
      ts: '2026-06-15T00:00:00.000Z',
      value: 1,
      unit: 'count',
      labels: { status: 503 },
    })
    expect(sink.lines).toHaveLength(1)
    const parsed = JSON.parse(sink.lines[0]!)
    expect(parsed).toMatchObject({ kind: 'metric', type: 'http.5xx', value: 1, labels: { status: 503 } })
  })
})
