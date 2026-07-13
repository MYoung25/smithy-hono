/**
 * LIVE conformance — runs the security-core storage conformance suites against
 * the DynamoDB stores wired to a REAL DynamoDB (DynamoDB Local) via the real
 * {@link createDynamoTablePort} over an `@aws-sdk/lib-dynamodb` DocumentClient.
 * This validates the actual conditional writes (`attribute_not_exists(pk)`,
 * version CAS) against a live engine — the strong-consistency guarantees
 * `stores.conformance.test.ts` exercises only through the in-process fake.
 *
 * Gated on `DYNAMODB_ENDPOINT` so the normal suite skips it. To run:
 *
 *   docker run --rm -d -p 8000:8000 amazon/dynamodb-local
 *   DYNAMODB_ENDPOINT=http://localhost:8000 npx vitest run src/live.dynamodb.test.ts
 *
 * Each factory call gets a unique `pk` namespace (rewritten on the send path),
 * so the conformance suites are isolated within the single shared table.
 */

import { beforeAll, afterAll, describe, it } from 'vitest'
import {
  describeSessionStore,
  describeRateLimitStore,
  describeNonceStore,
} from '@smithy-hono/security-core/storage/conformance'
import { createDynamoTablePort } from './dynamoPort.js'
import type { DynamoSendLike } from './dynamoPort.js'
import { DynamoSessionStore } from './stores/session.js'
import { DynamoRateLimitStore } from './stores/rateLimit.js'
import { DynamoNonceStore } from './stores/nonce.js'

const ENDPOINT = process.env.DYNAMODB_ENDPOINT
const TABLE = 'shono-security-live'

/** Wrap a send fn so every command's `pk` value is prefixed — isolates a suite. */
function namespaced(send: DynamoSendLike, ns: string): DynamoSendLike {
  return {
    send(cmd: unknown) {
      const c = { ...(cmd as Record<string, unknown>) }
      const key = c.Key as { pk?: string } | undefined
      if (key && typeof key.pk === 'string') c.Key = { ...key, pk: ns + key.pk }
      const item = c.Item as { pk?: string } | undefined
      if (item && typeof item.pk === 'string') c.Item = { ...item, pk: ns + item.pk }
      return send.send(c)
    },
  }
}

if (!ENDPOINT) {
  describe.skip('adapter-aws — live DynamoDB conformance (set DYNAMODB_ENDPOINT to run)', () => {
    it('skipped — DYNAMODB_ENDPOINT not set', () => {})
  })
} else {
  let baseSend: DynamoSendLike
  let n = 0
  const ns = (p: string): string => `live:${p}:${++n}:`

  beforeAll(async () => {
    const ddbMod = (await import('@aws-sdk/client-dynamodb')) as typeof import('@aws-sdk/client-dynamodb')
    const docMod = (await import('@aws-sdk/lib-dynamodb')) as typeof import('@aws-sdk/lib-dynamodb')
    const { DynamoDBClient, CreateTableCommand, DescribeTableCommand } = ddbMod
    const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, DeleteCommand } = docMod

    const ddb = new DynamoDBClient({
      endpoint: ENDPOINT,
      region: 'us-east-1',
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    })

    // Create the single table (pk partition key); ignore "already exists".
    try {
      await ddb.send(
        new CreateTableCommand({
          TableName: TABLE,
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          BillingMode: 'PAY_PER_REQUEST',
        }),
      )
      // Wait until ACTIVE.
      for (let i = 0; i < 20; i++) {
        const d = await ddb.send(new DescribeTableCommand({ TableName: TABLE }))
        if (d.Table?.TableStatus === 'ACTIVE') break
        await new Promise((r) => setTimeout(r, 100))
      }
    } catch (e) {
      if ((e as { name?: string }).name !== 'ResourceInUseException') throw e
    }

    const doc = DynamoDBDocumentClient.from(ddb)
    const ctor = { Put: PutCommand, Get: GetCommand, Update: UpdateCommand, Delete: DeleteCommand }
    baseSend = {
      send(cmd: unknown) {
        const { __command, ...input } = cmd as { __command: keyof typeof ctor }
        const C = ctor[__command]
        // `C` is a union of command constructors, so `new C(...)` is a union that
        // the DocumentClient's strict per-command `send` overloads reject — cast
        // through `never` for this dynamic dispatch (the runtime picks the right one).
        return doc.send(new C(input as never) as never) as Promise<
          { Item?: Record<string, unknown> } & Record<string, unknown>
        >
      },
    }
  })

  afterAll(() => {
    // DynamoDB Local is ephemeral (container torn down by the caller); nothing to close.
  })

  const port = (p: string) => createDynamoTablePort(namespaced(baseSend, ns(p)), TABLE)

  describeSessionStore('DynamoSessionStore (live DynamoDB)', () => new DynamoSessionStore(port('sess')))
  describeRateLimitStore('DynamoRateLimitStore (live DynamoDB)', () => new DynamoRateLimitStore(port('rl')))
  describeNonceStore('DynamoNonceStore (live DynamoDB)', () => new DynamoNonceStore(port('nonce')))
}
