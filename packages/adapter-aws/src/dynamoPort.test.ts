/**
 * Unit tests for the REAL DynamoDB port over a structural `.send` mock — an
 * in-memory table that interprets the tagged command inputs (Put/Get/Update/
 * Delete) the way DynamoDB + the document client would, INCLUDING evaluating the
 * ConditionExpressions (`attribute_not_exists(pk)`, `version = :expected`) and
 * raising a `ConditionalCheckFailedException` on failure. This exercises the
 * port's marshalling, conditional-put false return, and CAS retry/version logic
 * WITHOUT the AWS SDK. The true concurrent-writer behavior is deferred to live
 * DynamoDB in Part D.
 */

import { describe, it, expect } from 'vitest'
import { createDynamoTablePort, type DynamoSendLike } from './dynamoPort.js'

class ConditionalCheckFailedException extends Error {
  name = 'ConditionalCheckFailedException'
}

/** A mock DynamoDB that honors the ConditionExpressions the port emits. */
function mockClient(): { client: DynamoSendLike; table: Map<string, Record<string, unknown>> } {
  const table = new Map<string, Record<string, unknown>>()
  const client: DynamoSendLike = {
    async send(cmd: any) {
      const { __command, ...input } = cmd
      const pk = (input.Key ?? input.Item)?.pk as string
      switch (__command) {
        case 'Get':
          return { Item: table.get(pk) }
        case 'Put': {
          const cond = input.ConditionExpression as string | undefined
          const existing = table.get(pk)
          if (cond?.includes('attribute_not_exists') && existing) {
            throw new ConditionalCheckFailedException('exists')
          }
          if (cond?.includes('= :expected')) {
            const expected = input.ExpressionAttributeValues?.[':expected']
            if (!existing || existing.version !== expected) {
              throw new ConditionalCheckFailedException('version conflict')
            }
          }
          table.set(pk, input.Item)
          return {}
        }
        case 'Delete':
          table.delete(pk)
          return {}
        default:
          throw new Error(`unexpected command ${__command}`)
      }
    },
  }
  return { client, table }
}

describe('createDynamoTablePort (real port over mock send)', () => {
  it('getItem returns null when absent and the item when present', async () => {
    const { client, table } = mockClient()
    const port = createDynamoTablePort(client, 'T')
    expect(await port.getItem({ pk: 'a' })).toBeNull()
    table.set('a', { pk: 'a', v: 1, version: 1 })
    expect(await port.getItem({ pk: 'a' })).toMatchObject({ pk: 'a', v: 1 })
  })

  it('putItem ifNotExists returns true once, false on replay', async () => {
    const port = createDynamoTablePort(mockClient().client, 'T')
    expect(await port.putItem({ pk: 'n1' }, { ifNotExists: true })).toBe(true)
    expect(await port.putItem({ pk: 'n1' }, { ifNotExists: true })).toBe(false)
  })

  it('putItem unconditional upserts and stamps version=1', async () => {
    const { client, table } = mockClient()
    const port = createDynamoTablePort(client, 'T')
    expect(await port.putItem({ pk: 'a', v: 7 })).toBe(true)
    expect(table.get('a')).toMatchObject({ pk: 'a', v: 7, version: 1 })
  })

  it('updateConditional inserts on a fresh key and bumps version on update', async () => {
    const { client, table } = mockClient()
    const port = createDynamoTablePort(client, 'T')
    await port.updateConditional({ pk: 'b' }, () => ({ tokens: 5 }))
    expect(table.get('b')).toMatchObject({ tokens: 5, version: 1 })
    await port.updateConditional({ pk: 'b' }, (cur) => ({ tokens: (cur!.tokens as number) - 1 }))
    expect(table.get('b')).toMatchObject({ tokens: 4, version: 2 })
  })

  it('updateConditional returns true (no-op) when mutate returns null', async () => {
    const { client, table } = mockClient()
    const port = createDynamoTablePort(client, 'T')
    expect(await port.updateConditional({ pk: 'gone' }, () => null)).toBe(true)
    expect(table.has('gone')).toBe(false)
  })

  it('updateConditional retries on a version conflict injected mid-flight', async () => {
    const { client, table } = mockClient()
    const port = createDynamoTablePort(client, 'T')
    table.set('c', { pk: 'c', tokens: 5, version: 1 })

    let firstRead = true
    await port.updateConditional({ pk: 'c' }, (cur) => {
      if (firstRead) {
        firstRead = false
        // Simulate a concurrent writer winning between our read and write:
        // bump the stored version so our CAS (expecting v1) fails → retry.
        table.set('c', { pk: 'c', tokens: 4, version: 2 })
      }
      return { tokens: (cur!.tokens as number) - 1 }
    })
    // After the retry it reads version 2 (tokens 4) and commits version 3.
    expect(table.get('c')).toMatchObject({ tokens: 3, version: 3 })
  })

  it('deleteItem is idempotent', async () => {
    const port = createDynamoTablePort(mockClient().client, 'T')
    await port.deleteItem({ pk: 'x' }) // no throw on absent
    await port.putItem({ pk: 'x' })
    await port.deleteItem({ pk: 'x' })
    expect(await port.getItem({ pk: 'x' })).toBeNull()
  })
})
