import { describe, it, expect, vi, afterEach } from 'vitest'
import { ChainedAuditSink, type AuditEvent } from '@smithy-hono/security-core'
import { createConsoleAuditSink, createConsoleMetricsSink } from './auditSink.js'

function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    type: 'ratelimit.trip',
    ts: '2026-06-15T00:00:00.000Z',
    requestId: 'req-1',
    principalRef: null,
    outcome: 'deny',
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createConsoleAuditSink (CF → Logpush)', () => {
  it('writes one JSON line per audit event via console.log tagged kind=audit', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const audit = createConsoleAuditSink({ base: { service: 'todo-api' } })
    await audit.emit(event({ detail: { scope: 'ip', retryAfterSeconds: 3 } }))
    expect(spy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(spy.mock.calls[0]![0] as string)
    expect(parsed).toMatchObject({
      kind: 'audit',
      service: 'todo-api',
      type: 'ratelimit.trip',
      requestId: 'req-1',
      principalRef: null,
      outcome: 'deny',
      detail: { scope: 'ip', retryAfterSeconds: 3 },
    })
  })

  it('emits a key.rotate event (OPS-03 forward-compat)', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await createConsoleAuditSink().emit(
      event({ type: 'key.rotate', outcome: 'allow', detail: { keyId: 'k2' } }),
    )
    const parsed = JSON.parse(spy.mock.calls[0]![0] as string)
    expect(parsed.type).toBe('key.rotate')
    expect(parsed.detail).toEqual({ keyId: 'k2' })
  })

  it('passes through the LOG-12 chain fields when wrapped in ChainedAuditSink', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const chained = new ChainedAuditSink(createConsoleAuditSink())
    await chained.emit(event())
    const parsed = JSON.parse(spy.mock.calls[0]![0] as string)
    expect(parsed.seq).toBe(0)
    expect(parsed.hash).toHaveLength(64)
  })
})

describe('createConsoleMetricsSink (CF → Logpush)', () => {
  it('writes one JSON line per metric signal tagged kind=metric', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    createConsoleMetricsSink().emit({
      type: 'cert.expiry',
      ts: '2026-06-15T00:00:00.000Z',
      value: 86400,
      unit: 'seconds',
      labels: { subject: 'api.example.com' },
    })
    const parsed = JSON.parse(spy.mock.calls[0]![0] as string)
    expect(parsed).toMatchObject({ kind: 'metric', type: 'cert.expiry', value: 86400, unit: 'seconds' })
  })
})
