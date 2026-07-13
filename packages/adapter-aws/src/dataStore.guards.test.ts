/**
 * Focused regression tests for two adapter-aws DataStore guards:
 *
 *   - count/list cap-and-refusal must key off the index VALUE, not just a
 *     declared index NAME: `{index:'kind', filter:{status:'open'}}` (no `kind`
 *     entry) must fall to the base-table path — count REFUSES the exact count and
 *     list applies SCAN_CAP — instead of silently draining the whole partition.
 *   - list() normalizes a malformed cursor to a typed RangeError (4xx), matching
 *     the limit<1 path, rather than letting a raw DOMException/URIError escape.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createDynamoDataPort, createDynamoDataStore, createFakeDynamoDataPort } from './dataStore.js'
import type { DynamoSendLike } from './dynamoPort.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createDynamoDataPort — declared-index-without-value routing', () => {
  it('count REFUSES an exact count when the declared index has no filter value', async () => {
    let sent = 0
    const client: DynamoSendLike = {
      async send() {
        sent++
        return {}
      },
    }
    const port = createDynamoDataPort(client, 'T', { indexes: ['kind'] })
    // index 'kind' declared, but filter carries only the undeclared 'status'.
    await expect(port.count('scope', { status: 'open' }, 'kind', true)).rejects.toThrow(
      /exact count on a non-declared index/,
    )
    expect(sent).toBe(0) // refused BEFORE issuing any partition-draining Query
  })

  it('list applies the SCAN_CAP (warns) when the declared index has no filter value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client: DynamoSendLike = {
      async send() {
        return { Items: [] } // empty page ends the loop immediately
      },
    }
    const port = createDynamoDataPort(client, 'T', { indexes: ['kind'] })
    await port.listRows('scope', { limit: 5, filter: { status: 'open' }, index: 'kind', excludeDeleted: false })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(/capped partition scan/)
  })

  it('list does NOT warn when the declared index DOES have a filter value (GSI path)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client: DynamoSendLike = {
      async send() {
        return { Items: [] }
      },
    }
    const port = createDynamoDataPort(client, 'T', { indexes: ['kind'] })
    await port.listRows('scope', { limit: 5, filter: { kind: 'red' }, index: 'kind', excludeDeleted: false })
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('DynamoDataStore.list — malformed cursor', () => {
  it('normalizes a malformed cursor to a Range- (4xx) error, not a raw DOMException', async () => {
    const store = createDynamoDataStore(createFakeDynamoDataPort(), { indexes: ['kind'] })
    await expect(store.list({ limit: 5, cursor: '###' }, {})).rejects.toThrow(/invalid cursor/)
    await expect(store.list({ limit: 5, cursor: '###' }, {})).rejects.toBeInstanceOf(RangeError)
  })
})
