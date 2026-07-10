import { describe, it, expect, vi, afterEach } from 'vitest'
import { ChainedAuditSink, type AuditEvent } from '@smithy-hono/security-core'
import { createStdoutAuditSink, createStdoutMetricsSink } from './auditSink.js'

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

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createStdoutAuditSink (Node → stdout/log shipper)', () => {
  it('writes one JSON line per audit event to stdout tagged kind=audit', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const audit = createStdoutAuditSink({ base: { service: 'todo-api' } })
    await audit.emit(event({ detail: { reason: 'bad cookie' } }))
    expect(spy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(spy.mock.calls[0]![0] as string)
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

  it('emits a key.rotate event (OPS-03 forward-compat)', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await createStdoutAuditSink().emit(
      event({ type: 'key.rotate', principalRef: null, outcome: 'allow', detail: { keyId: 'k2' } }),
    )
    const parsed = JSON.parse(spy.mock.calls[0]![0] as string)
    expect(parsed.type).toBe('key.rotate')
    expect(parsed.detail).toEqual({ keyId: 'k2' })
  })

  it('passes through the LOG-12 chain fields when wrapped in ChainedAuditSink', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const chained = new ChainedAuditSink(createStdoutAuditSink())
    await chained.emit(event())
    const parsed = JSON.parse(spy.mock.calls[0]![0] as string)
    expect(parsed.seq).toBe(0)
    expect(parsed.hash).toHaveLength(64)
  })
})

describe('createStdoutMetricsSink (Node → stdout/log shipper)', () => {
  it('writes one JSON line per metric signal tagged kind=metric', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    createStdoutMetricsSink().emit({
      type: 'ratelimit.saturation',
      ts: '2026-06-15T00:00:00.000Z',
      value: 1,
      unit: 'count',
      labels: { scope: 'ip' },
    })
    const parsed = JSON.parse(spy.mock.calls[0]![0] as string)
    expect(parsed).toMatchObject({ kind: 'metric', type: 'ratelimit.saturation', labels: { scope: 'ip' } })
  })
})
