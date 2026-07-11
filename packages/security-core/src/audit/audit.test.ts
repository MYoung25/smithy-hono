import { describe, it, expect } from 'vitest'
import {
  buildAuditEvent,
  pseudonymize,
  createPseudonymizer,
  defaultPseudonymize,
  emitAudit,
  canonical,
  ChainedAuditSink,
} from './audit.js'
import type { AuditEvent, AuditSink } from '../config.js'

/** A capturing sink that records every emitted event in order. */
function captureSink(): AuditSink & { events: AuditEvent[] } {
  const events: AuditEvent[] = []
  return {
    events,
    emit: async (e) => {
      events.push(e)
    },
  }
}

/** Recompute SHA-256(prevHash + canonical(event)) the way ChainedAuditSink does. */
async function recomputeHash(prevHash: string, event: AuditEvent): Promise<string> {
  const data = new TextEncoder().encode(prevHash + canonical(event))
  const digest = await crypto.subtle.digest('SHA-256', data)
  let hex = ''
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0')
  return hex
}

describe('buildAuditEvent (LOG-10)', () => {
  it('stamps ts (RFC3339) and the supplied fields', () => {
    const e = buildAuditEvent({
      type: 'auth.failure',
      requestId: 'req-1',
      principalRef: 'ref-abc',
      operation: 'GetTodo',
      outcome: 'deny',
      detail: { reason: 'bad cookie' },
    })
    expect(e.type).toBe('auth.failure')
    expect(e.requestId).toBe('req-1')
    expect(e.principalRef).toBe('ref-abc')
    expect(e.operation).toBe('GetTodo')
    expect(e.outcome).toBe('deny')
    expect(e.detail).toEqual({ reason: 'bad cookie' })
    // ts is a valid ISO-8601 / RFC3339 timestamp.
    expect(Number.isNaN(Date.parse(e.ts))).toBe(false)
    expect(e.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('omits operation/detail when not supplied and never sets chain fields', () => {
    const e = buildAuditEvent({
      type: 'ratelimit.trip',
      requestId: 'req-2',
      principalRef: null,
      outcome: 'deny',
    })
    expect('operation' in e).toBe(false)
    expect('detail' in e).toBe(false)
    expect(e.seq).toBeUndefined()
    expect(e.prevHash).toBeUndefined()
    expect(e.hash).toBeUndefined()
  })

  it('redacts sensitiveFields from detail at the build chokepoint (AUDIT-LOGGING-04)', () => {
    const detail = { body: { name: 'x', token: 'super-secret' } }
    const e = buildAuditEvent({
      type: 'authz.deny',
      requestId: 'req-3',
      principalRef: null,
      outcome: 'deny',
      detail,
      sensitiveFields: ['body.token'],
    })
    expect(e.detail).toEqual({ body: { name: 'x', token: '[REDACTED]' } })
    // The caller's object is never mutated.
    expect(detail.body.token).toBe('super-secret')
  })

  it('passes detail through unchanged when no sensitiveFields are supplied', () => {
    const e = buildAuditEvent({
      type: 'authz.deny',
      requestId: 'req-4',
      principalRef: null,
      outcome: 'deny',
      detail: { reason: 'no scope' },
    })
    expect(e.detail).toEqual({ reason: 'no scope' })
  })
})

describe('pseudonymize (LOG-11)', () => {
  it('is stable for the same input', async () => {
    expect(await pseudonymize('user-42')).toBe(await pseudonymize('user-42'))
  })

  it('differs for different inputs', async () => {
    expect(await pseudonymize('user-42')).not.toBe(await pseudonymize('user-43'))
  })

  it('never returns the raw id', async () => {
    const ref = await pseudonymize('user-42')
    expect(ref).not.toBe('user-42')
    expect(ref).not.toContain('user-42')
  })

  it('same id + different salts → different refs (cross-deployment non-correlation)', async () => {
    expect(await pseudonymize('user-42', 'salt-A')).not.toBe(
      await pseudonymize('user-42', 'salt-B'),
    )
  })

  it('same id + same salt → stable ref', async () => {
    expect(await pseudonymize('user-42', 'salt-A')).toBe(
      await pseudonymize('user-42', 'salt-A'),
    )
  })

  it('keyed (HMAC) ref differs from the unkeyed (bare-hash) ref for the same id', async () => {
    expect(await pseudonymize('user-42', 'salt-A')).not.toBe(
      await pseudonymize('user-42'),
    )
  })
})

describe('createPseudonymizer (LOG-11 keyed default)', () => {
  it('is stable for the same id under the same key', async () => {
    const p = createPseudonymizer('deploy-key-1')
    expect(await p('user-42')).toBe(await p('user-42'))
  })

  it('different deployment keys → different refs for the same id (non-correlation)', async () => {
    const a = createPseudonymizer('deploy-key-A')
    const b = createPseudonymizer('deploy-key-B')
    expect(await a('user-42')).not.toBe(await b('user-42'))
  })

  it('matches pseudonymize keyed by the same salt (HMAC construction)', async () => {
    const p = createPseudonymizer('deploy-key-1')
    expect(await p('user-42')).toBe(await pseudonymize('user-42', 'deploy-key-1'))
  })

  it('never returns or leaks the raw id', async () => {
    const ref = await createPseudonymizer('deploy-key-1')('user-42')
    expect(ref).not.toBe('user-42')
    expect(ref).not.toContain('user-42')
  })

  it('rejects an empty salt (no unkeyed production default)', () => {
    expect(() => createPseudonymizer('')).toThrow(RangeError)
  })
})

describe('defaultPseudonymize (INSECURE dev/test fallback)', () => {
  it('is stable and never returns the raw id', async () => {
    expect(await defaultPseudonymize('user-42')).toBe(await defaultPseudonymize('user-42'))
    expect(await defaultPseudonymize('user-42')).not.toContain('user-42')
  })

  it('is keyed (not a bare unsalted hash of the id)', async () => {
    // Hardening of RT-12: the fallback must not equal the unkeyed SHA-256 ref,
    // proving the unsalted-by-default path is gone.
    expect(await defaultPseudonymize('user-42')).not.toBe(await pseudonymize('user-42'))
  })

  it('differs from a real deployment-keyed pseudonymizer (must be replaced in prod)', async () => {
    expect(await defaultPseudonymize('user-42')).not.toBe(
      await createPseudonymizer('real-deploy-secret')('user-42'),
    )
  })
})

describe('emitAudit (LOG-10 best-effort)', () => {
  it('no-ops when the sink is undefined', async () => {
    await expect(emitAudit(undefined, buildAuditEvent({
      type: 'auth.success', requestId: 'r', principalRef: null, outcome: 'allow',
    }))).resolves.toBeUndefined()
  })

  it('delivers to the sink', async () => {
    const sink = captureSink()
    const e = buildAuditEvent({ type: 'auth.success', requestId: 'r', principalRef: null, outcome: 'allow' })
    await emitAudit(sink, e)
    expect(sink.events).toEqual([e])
  })

  it('never throws when the sink throws, and surfaces via the logger', async () => {
    const logged: Record<string, unknown>[] = []
    const throwingSink: AuditSink = {
      emit: async () => {
        throw new Error('sink down')
      },
    }
    const e = buildAuditEvent({ type: 'sig.fail', requestId: 'r', principalRef: null, outcome: 'error' })
    await expect(
      emitAudit(throwingSink, e, { info: () => {}, warn: () => {}, error: (rec) => logged.push(rec) }),
    ).resolves.toBeUndefined()
    expect(logged).toHaveLength(1)
  })

  it('falls back to console.error when no logger is provided (AUDIT-LOGGING-05)', async () => {
    const calls: unknown[][] = []
    const original = console.error
    console.error = (...args: unknown[]) => {
      calls.push(args)
    }
    try {
      const throwingSink: AuditSink = {
        emit: async () => {
          throw new Error('sink down')
        },
      }
      const e = buildAuditEvent({ type: 'sig.fail', requestId: 'r', principalRef: null, outcome: 'error' })
      await expect(emitAudit(throwingSink, e)).resolves.toBeUndefined()
      expect(calls).toHaveLength(1)
      expect(calls[0]![0]).toMatchObject({ msg: 'audit sink emit failed', type: 'sig.fail' })
    } finally {
      console.error = original
    }
  })
})

describe('ChainedAuditSink (LOG-12)', () => {
  it('links events: seq increments and each hash chains from the previous', async () => {
    const delegate = captureSink()
    const chain = new ChainedAuditSink(delegate)

    const e1 = buildAuditEvent({ type: 'auth.success', requestId: 'r1', principalRef: 'a', outcome: 'allow' })
    const e2 = buildAuditEvent({ type: 'auth.failure', requestId: 'r2', principalRef: 'b', outcome: 'deny' })
    const e3 = buildAuditEvent({ type: 'ratelimit.trip', requestId: 'r3', principalRef: null, outcome: 'deny' })
    await chain.emit(e1)
    await chain.emit(e2)
    await chain.emit(e3)

    const [c1, c2, c3] = delegate.events
    expect([c1!.seq, c2!.seq, c3!.seq]).toEqual([0, 1, 2])
    expect(c1!.prevHash).toBe('')
    expect(c2!.prevHash).toBe(c1!.hash)
    expect(c3!.prevHash).toBe(c2!.hash)

    // Each hash equals SHA-256(prevHash + canonical(event-without-chain-fields)).
    expect(c1!.hash).toBe(await recomputeHash('', e1))
    expect(c2!.hash).toBe(await recomputeHash(c1!.hash!, e2))
    expect(c3!.hash).toBe(await recomputeHash(c2!.hash!, e3))
  })

  it('verifies an intact chain by re-walking the delegate-captured events', async () => {
    const delegate = captureSink()
    const chain = new ChainedAuditSink(delegate)
    for (let i = 0; i < 5; i++) {
      await chain.emit(buildAuditEvent({
        type: 'auth.success', requestId: `r${i}`, principalRef: `p${i}`, outcome: 'allow',
      }))
    }

    let prev = ''
    for (const ev of delegate.events) {
      expect(ev.prevHash).toBe(prev)
      expect(ev.hash).toBe(await recomputeHash(prev, ev))
      prev = ev.hash!
    }
  })

  it('detects tampering: altering an event detail breaks the recomputed hash', async () => {
    const delegate = captureSink()
    const chain = new ChainedAuditSink(delegate)
    await chain.emit(buildAuditEvent({ type: 'auth.success', requestId: 'r1', principalRef: 'a', outcome: 'allow' }))
    await chain.emit(buildAuditEvent({ type: 'authz.deny', requestId: 'r2', principalRef: 'b', outcome: 'deny', detail: { scope: 'todos.write' } }))

    // Tamper with the stored second event's detail after the fact.
    const tampered = delegate.events[1]!
    tampered.detail = { scope: 'admin.everything' }

    // Re-walking now finds a mismatch at the tampered event.
    const recomputed = await recomputeHash(tampered.prevHash!, tampered)
    expect(recomputed).not.toBe(tampered.hash)
  })

  it('does not mutate the caller event object (stamps a copy)', async () => {
    const delegate = captureSink()
    const chain = new ChainedAuditSink(delegate)
    const original = buildAuditEvent({ type: 'auth.success', requestId: 'r1', principalRef: 'a', outcome: 'allow' })
    await chain.emit(original)
    expect(original.seq).toBeUndefined()
    expect(original.hash).toBeUndefined()
    expect(delegate.events[0]!.seq).toBe(0)
  })

  it('serializes CONCURRENT emits into one coherent chain (finding audit-logging-2)', async () => {
    // A single shared sink under concurrent in-flight emits must not fork the
    // chain: without serialization both emits read the same seq/prevHash across
    // the `await sha256Hex(...)` and stamp duplicate seq/prevHash.
    const delegate = captureSink()
    const chain = new ChainedAuditSink(delegate)
    const N = 20
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        chain.emit(
          buildAuditEvent({ type: 'auth.success', requestId: `r${i}`, principalRef: `p${i}`, outcome: 'allow' }),
        ),
      ),
    )
    // Exactly N events, strictly increasing unique seq 0..N-1, and each hash links.
    expect(delegate.events).toHaveLength(N)
    expect(delegate.events.map((e) => e.seq)).toEqual(Array.from({ length: N }, (_, i) => i))
    let prev = ''
    for (const ev of delegate.events) {
      expect(ev.prevHash).toBe(prev)
      expect(ev.hash).toBe(await recomputeHash(prev, ev))
      prev = ev.hash!
    }
  })

  it('a failing emit rejects its own caller but does not poison the chain', async () => {
    let calls = 0
    const delegate: AuditSink & { events: AuditEvent[] } = {
      events: [],
      emit: async (e) => {
        calls++
        if (calls === 1) throw new Error('delegate boom')
        delegate.events.push(e)
      },
    }
    const chain = new ChainedAuditSink(delegate)
    await expect(
      chain.emit(buildAuditEvent({ type: 'auth.success', requestId: 'r1', principalRef: 'a', outcome: 'allow' })),
    ).rejects.toThrow('delegate boom')
    // A subsequent emit still succeeds and lands (the tail swallowed the rejection).
    await chain.emit(buildAuditEvent({ type: 'auth.success', requestId: 'r2', principalRef: 'b', outcome: 'allow' }))
    expect(delegate.events).toHaveLength(1)
    expect(delegate.events[0]!.requestId).toBe('r2')
  })

  it('a dropped (thrown) write leaves NO chain gap — next event links from the last good hash (finding audit-logging-2)', async () => {
    // Advance-after-delegate: on a delegate throw seq/prevHash do NOT advance, so
    // a re-walk of the persisted events stays contiguous (no phantom gap that a
    // verifier would read as tampering).
    let calls = 0
    const delegate: AuditSink & { events: AuditEvent[] } = {
      events: [],
      emit: async (e) => {
        calls++
        if (calls === 2) throw new Error('drop the middle write')
        delegate.events.push(e)
      },
    }
    const chain = new ChainedAuditSink(delegate)
    await chain.emit(buildAuditEvent({ type: 'auth.success', requestId: 'r1', principalRef: 'a', outcome: 'allow' }))
    await expect(
      chain.emit(buildAuditEvent({ type: 'auth.failure', requestId: 'r2', principalRef: 'b', outcome: 'deny' })),
    ).rejects.toThrow('drop the middle write')
    await chain.emit(buildAuditEvent({ type: 'auth.success', requestId: 'r3', principalRef: 'c', outcome: 'allow' }))

    // Only the two SUCCESSFUL writes are persisted, with contiguous seq 0,1 and an
    // intact hash chain — the dropped event left no seq gap or dangling prevHash.
    expect(delegate.events.map((e) => e.requestId)).toEqual(['r1', 'r3'])
    expect(delegate.events.map((e) => e.seq)).toEqual([0, 1])
    let prev = ''
    for (const ev of delegate.events) {
      expect(ev.prevHash).toBe(prev)
      expect(ev.hash).toBe(await recomputeHash(prev, ev))
      prev = ev.hash!
    }
  })
})

describe('principalRef (shared salt-presence rule, finding audit-logging-14)', () => {
  it('routes an EMPTY-STRING salt to the insecure dev fallback, not HMAC("")', async () => {
    const { principalRef } = await import('./audit.js')
    expect(await principalRef('user-1', '')).toBe(await defaultPseudonymize('user-1'))
  })

  it('an undefined salt also routes to the dev fallback', async () => {
    const { principalRef } = await import('./audit.js')
    expect(await principalRef('user-1', undefined)).toBe(await defaultPseudonymize('user-1'))
  })

  it('a present non-empty salt uses the keyed HMAC', async () => {
    const { principalRef } = await import('./audit.js')
    const salt = 'deployment-salt-0123456789abcdef'
    expect(await principalRef('user-1', salt)).toBe(await pseudonymize('user-1', salt))
    expect(await principalRef('user-1', salt)).not.toBe(await defaultPseudonymize('user-1'))
  })
})
