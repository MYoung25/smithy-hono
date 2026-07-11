/**
 * The REAL {@link DynamoTablePort} — maps the narrow port ops onto DynamoDB
 * commands through a structural client, so this package typechecks and tests
 * WITHOUT installing `@aws-sdk/*` (ARCH-01, dependency discipline).
 *
 * The consumer passes their real `DynamoDBDocumentClient` (recommended — it
 * marshalls native JS values to/from AttributeValues for us) as the
 * {@link DynamoSendLike}; we only ever call `.send(command)`. The command shapes
 * below are exactly the DocumentClient command INPUTS (`PutCommand`,
 * `GetCommand`, `UpdateCommand`, `DeleteCommand` inputs), constructed as plain
 * objects and handed to `.send` — the SDK turns the plain input into the wire
 * command. (If you use the low-level `DynamoDBClient`, marshall the values and
 * wrap with the corresponding `*Command` constructors yourself in a thin
 * `DynamoSendLike`.)
 *
 * Optimistic concurrency uses a numeric `version` attribute the port manages
 * end-to-end: every write bumps it, every conditional write guards on it.
 *
 * Table schema (document in your infra-as-code):
 *   - Partition key:  `pk`  (String)  — the only key attribute; no sort key.
 *   - TTL attribute:  `ttl` (Number, epoch SECONDS) — enable DynamoDB TTL on it.
 *   - Version attr:   `version` (Number) — managed by this port; do not touch.
 */

import type { DynamoTablePort, ItemKey } from './port.js'
import { PK_ATTR, VERSION_ATTR } from './port.js'

/**
 * The minimal structural DynamoDB client this port needs. A real
 * `DynamoDBDocumentClient` satisfies this directly. We never import the SDK; we
 * only call `.send` with plain command-input objects (see {@link toCommand}).
 */
export interface DynamoSendLike {
  send(command: unknown): Promise<{ Item?: Record<string, unknown> } & Record<string, unknown>>
}

/** Bounded retries on the CAS path before surfacing the conflict to the caller. */
const MAX_CAS_RETRIES = 16

/**
 * Tag a plain command-input object with which DocumentClient command it is, so a
 * thin shim can construct the real `*Command` if a consumer is NOT using the
 * lib-dynamodb document client. With the document client, pass these inputs to
 * the matching command constructor in your shim; see the README wiring example.
 */
function toCommand(kind: 'Put' | 'Get' | 'Update' | 'Delete', input: Record<string, unknown>): unknown {
  return { __command: kind, ...input }
}

/**
 * Create the real port over a structural DynamoDB document client + table name.
 *
 * NOTE on `.send` wiring: because we cannot import `@aws-sdk/lib-dynamodb` here,
 * `.send` receives a `toCommand(...)`-tagged plain input. In your service,
 * supply a tiny `DynamoSendLike` that translates the tag into the real command:
 *
 * ```ts
 * import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, DeleteCommand }
 *   from '@aws-sdk/lib-dynamodb'
 * const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}))
 * const sendLike: DynamoSendLike = {
 *   send(cmd: any) {
 *     const { __command, ...input } = cmd
 *     const C = { Put: PutCommand, Get: GetCommand, Update: UpdateCommand, Delete: DeleteCommand }[__command]
 *     return doc.send(new C(input))
 *   },
 * }
 * const port = createDynamoTablePort(sendLike, 'my-security-table')
 * ```
 */
export function createDynamoTablePort(client: DynamoSendLike, tableName: string): DynamoTablePort {
  async function read(key: ItemKey): Promise<Record<string, unknown> | null> {
    const out = await client.send(
      toCommand('Get', {
        TableName: tableName,
        Key: { [PK_ATTR]: key.pk },
        ConsistentRead: true, // strong consistency for rate-limit / nonce (mandate).
      }),
    )
    return (out.Item as Record<string, unknown> | undefined) ?? null
  }

  return {
    getItem: read,

    async putItem(item, opts) {
      const next = { ...item, [VERSION_ATTR]: 1 }
      try {
        await client.send(
          toCommand('Put', {
            TableName: tableName,
            Item: next,
            ...(opts?.ifNotExists
              ? {
                  ConditionExpression: 'attribute_not_exists(#pk)',
                  ExpressionAttributeNames: { '#pk': PK_ATTR },
                }
              : {}),
          }),
        )
        return true
      } catch (err) {
        if (opts?.ifNotExists && isConditionalCheckFailed(err)) return false
        throw err
      }
    },

    async updateConditional(key, mutate) {
      for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
        const current = await read(key)
        const result = mutate(current)
        if (result === null) return true // mutate aborted → deliberate no-op.

        const currentVersion = typeof current?.[VERSION_ATTR] === 'number' ? (current[VERSION_ATTR] as number) : 0
        const next = { ...result, [PK_ATTR]: key.pk, [VERSION_ATTR]: currentVersion + 1 }

        try {
          await client.send(
            toCommand('Put', {
              TableName: tableName,
              Item: next,
              ConditionExpression: current
                ? '#v = :expected'
                : 'attribute_not_exists(#pk)',
              ExpressionAttributeNames: current
                ? { '#v': VERSION_ATTR }
                : { '#pk': PK_ATTR },
              ...(current ? { ExpressionAttributeValues: { ':expected': currentVersion } } : {}),
            }),
          )
          return true
        } catch (err) {
          if (isConditionalCheckFailed(err)) continue // version conflict → retry.
          throw err
        }
      }
      return false // contention budget exhausted → signal caller to give up/deny.
    },

    async deleteItem(key) {
      await client.send(
        toCommand('Delete', {
          TableName: tableName,
          Key: { [PK_ATTR]: key.pk },
        }),
      )
    },
  }
}

/** True for a DynamoDB `ConditionalCheckFailedException` (any SDK shape). */
function isConditionalCheckFailed(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const name = (err as { name?: unknown }).name
  const code = (err as { __type?: unknown }).__type
  return name === 'ConditionalCheckFailedException' || (typeof code === 'string' && code.includes('ConditionalCheckFailed'))
}
