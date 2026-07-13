/**
 * LIVE conformance — runs the `@smithy-hono/data-core` DataStore conformance
 * suite against the AWS adapter's DynamoDB store wired to a REAL DynamoDB
 * (DynamoDB Local) via the real {@link createDynamoDataPort} over an
 * `@aws-sdk/lib-dynamodb` DocumentClient. This validates the actual conditional
 * writes (`attribute_not_exists(pk)`, version CAS), the GSI `Query` filter, the
 * `Select: 'COUNT'`, and the `LastEvaluatedKey` opaque-cursor pagination — the
 * semantics `dataStore.conformance.test.ts` exercises only through the
 * in-process fake port.
 *
 * Gated on `DYNAMODB_ENDPOINT` so the normal suite skips it (mirrors
 * `live.dynamodb.test.ts`). To run:
 *
 *   docker run --rm -d -p 8000:8000 amazon/dynamodb-local
 *   DYNAMODB_ENDPOINT=http://localhost:8000 npx vitest run src/live.dynamodb.dataStore.test.ts
 *
 * The DataStore owns its OWN table (a `pk`/`sk` schema + a `kind` GSI) — distinct
 * from the security store's single-`pk` table. The table + GSI are created in
 * `beforeAll`; each factory call namespaces its scope partition (a unique `pk`
 * prefix injected on the send path), so the conformance variants are isolated
 * within the single shared table.
 */

import { beforeAll, afterAll, describe, it } from 'vitest'
import { describeDataStore, type Item } from '@smithy-hono/data-core/conformance'
import type { DataStore } from '@smithy-hono/data-core'
import { createDynamoDataPort } from './dataStore.js'
import type { DynamoSendLike } from './dynamoPort.js'
import { createDynamoDataStore } from './dataStore.js'

const ENDPOINT = process.env.DYNAMODB_ENDPOINT
const TABLE = 'shono-data-live'
const KIND_GSI = 'gsi_kind'
const KIND_GSI_PK = 'gsi_kind_pk'

/**
 * Wrap a send fn so every command's scope partition (`pk` / GSI `pk`) is
 * prefixed — isolates a conformance run within the shared table. The scope value
 * is the store's length-prefixed segment; prefixing it keeps cross-run isolation
 * without touching the GSI value suffix.
 */
function namespaced(send: DynamoSendLike, nsPrefix: string): DynamoSendLike {
  const px = (v: unknown): unknown => (typeof v === 'string' ? nsPrefix + v : v)
  return {
    send(cmd: unknown) {
      const c = { ...(cmd as Record<string, unknown>) }
      const key = c.Key as Record<string, unknown> | undefined
      if (key && typeof key.pk === 'string') c.Key = { ...key, pk: nsPrefix + key.pk }
      const item = c.Item as Record<string, unknown> | undefined
      if (item) {
        const ni = { ...item }
        if (typeof ni.pk === 'string') ni.pk = nsPrefix + ni.pk
        // The GSI partition key is `${scope}#${value}` — prefix the scope part.
        if (typeof ni[KIND_GSI_PK] === 'string') ni[KIND_GSI_PK] = nsPrefix + ni[KIND_GSI_PK]
        c.Item = ni
      }
      // Query KeyConditionExpression binds :pk / :gpk in ExpressionAttributeValues;
      // the atomic putRow UpdateItem binds the GSI partition key as :g_<field>
      // (`${scope}#${value}`). Prefix the scope part of all of them so an Update /
      // Query stays inside this run's namespaced partition.
      const eav = c.ExpressionAttributeValues as Record<string, unknown> | undefined
      if (eav) {
        const ne = { ...eav }
        if (typeof ne[':pk'] === 'string') ne[':pk'] = px(ne[':pk'])
        if (typeof ne[':gpk'] === 'string') ne[':gpk'] = px(ne[':gpk'])
        for (const key of Object.keys(ne)) {
          if (key.startsWith(':g_') && typeof ne[key] === 'string') ne[key] = px(ne[key])
        }
        c.ExpressionAttributeValues = ne
      }
      return send.send(c)
    },
  }
}

if (!ENDPOINT) {
  describe.skip('adapter-aws — live DynamoDB DataStore (set DYNAMODB_ENDPOINT to run)', () => {
    it('skipped — DYNAMODB_ENDPOINT not set', () => {})
  })
} else {
  let baseSend: DynamoSendLike
  let n = 0
  // A per-run id so leftover items from a previous run against the SAME persistent
  // DynamoDB-Local table (DataStore rows are not TTL-evicted, unlike the security
  // stores) never collide with this run's scope partitions.
  const RUN = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  const ns = (p: string): string => `live:${RUN}:${p}:${++n}:`

  beforeAll(async () => {
    const ddbMod = (await import('@aws-sdk/client-dynamodb')) as typeof import('@aws-sdk/client-dynamodb')
    const docMod = (await import('@aws-sdk/lib-dynamodb')) as typeof import('@aws-sdk/lib-dynamodb')
    const { DynamoDBClient, CreateTableCommand, DescribeTableCommand } = ddbMod
    const { DynamoDBDocumentClient, PutCommand, GetCommand, DeleteCommand, QueryCommand, UpdateCommand } =
      docMod

    const ddb = new DynamoDBClient({
      endpoint: ENDPOINT,
      region: 'us-east-1',
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    })

    // Create the DataStore table: pk (HASH) + sk (RANGE) base key, plus a GSI for
    // the `kind` declared index (gsi_kind_pk HASH + sk RANGE). Ignore "exists".
    try {
      await ddb.send(
        new CreateTableCommand({
          TableName: TABLE,
          AttributeDefinitions: [
            { AttributeName: 'pk', AttributeType: 'S' },
            { AttributeName: 'sk', AttributeType: 'S' },
            { AttributeName: KIND_GSI_PK, AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'pk', KeyType: 'HASH' },
            { AttributeName: 'sk', KeyType: 'RANGE' },
          ],
          GlobalSecondaryIndexes: [
            {
              IndexName: KIND_GSI,
              KeySchema: [
                { AttributeName: KIND_GSI_PK, KeyType: 'HASH' },
                { AttributeName: 'sk', KeyType: 'RANGE' },
              ],
              Projection: { ProjectionType: 'ALL' },
            },
          ],
          BillingMode: 'PAY_PER_REQUEST',
        }),
      )
      for (let i = 0; i < 30; i++) {
        const d = await ddb.send(new DescribeTableCommand({ TableName: TABLE }))
        if (d.Table?.TableStatus === 'ACTIVE') break
        await new Promise((r) => setTimeout(r, 100))
      }
    } catch (e) {
      if ((e as { name?: string }).name !== 'ResourceInUseException') throw e
    }

    const doc = DynamoDBDocumentClient.from(ddb)
    const ctor = {
      Put: PutCommand,
      Get: GetCommand,
      Delete: DeleteCommand,
      Query: QueryCommand,
      Update: UpdateCommand,
    }
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

  /**
   * GSI eventual-consistency tolerance — LIVE TEST ONLY. The shared conformance
   * filter tests create/update-then-IMMEDIATELY-filter. On the AWS adapter a
   * declared-index filter is served by a GSI, and a GSI is EVENTUALLY CONSISTENT
   * (DynamoDB has no `ConsistentRead` on a GSI), so against REAL AWS a just-written
   * item can briefly be absent from a filtered `list`/`count` → a flake. We do NOT
   * touch the shared conformance (DynamoDB-Local does not lag, so it'd be untested
   * elsewhere); instead we wrap ONLY the live store so a FILTERED `list`/`count`
   * that comes back empty is re-polled a bounded number of times before being
   * accepted. A genuinely-empty result still settles (it just costs the full
   * budget), and unfiltered/base-table reads (strongly consistent) are untouched.
   */
  const GSI_RETRIES = 8
  const GSI_DELAY_MS = 75
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  function gsiTolerant<T extends Record<string, unknown>>(
    s: DataStore<T>,
  ): DataStore<T> {
    const isFiltered = (q: { filter?: Record<string, unknown> } | undefined): boolean =>
      !!q?.filter && Object.keys(q.filter).length > 0
    // A Proxy delegates every other method (get/create/update/…) to the real store
    // unchanged, overriding ONLY the two GSI-served reads. (Spreading a class
    // instance would drop its prototype methods — a Proxy keeps them + `this`.)
    return new Proxy(s, {
      get(target, prop, receiver) {
        if (prop === 'list') {
          return async (query: Parameters<typeof s.list>[0], scope: Parameters<typeof s.list>[1]) => {
            let page = await target.list(query, scope)
            if (!isFiltered(query)) return page
            for (let i = 0; i < GSI_RETRIES && page.items.length === 0; i++) {
              await sleep(GSI_DELAY_MS)
              page = await target.list(query, scope)
            }
            return page
          }
        }
        if (prop === 'count' && typeof target.count === 'function') {
          const count = target.count.bind(target)
          return async (query: Parameters<NonNullable<typeof s.count>>[0], scope: Parameters<NonNullable<typeof s.count>>[1]) => {
            let n = await count(query, scope)
            if (!isFiltered(query)) return n
            for (let i = 0; i < GSI_RETRIES && n === 0; i++) {
              await sleep(GSI_DELAY_MS)
              n = await count(query, scope)
            }
            return n
          }
        }
        const value = Reflect.get(target, prop, receiver)
        // Bind delegated methods to the real store so their private-field access
        // (`#port`) resolves against the instance, not the Proxy.
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  /** A fresh, isolated DynamoDB-backed store per factory call (unique scope ns). */
  const store = (softDelete: boolean): DataStore<Item> =>
    gsiTolerant(
      createDynamoDataStore<Item>(
        createDynamoDataPort(namespaced(baseSend, ns(softDelete ? 'soft' : 'hard')), TABLE, {
          indexes: ['kind'],
        }),
        { table: TABLE, indexes: ['kind'], softDelete },
      ),
    )

  describeDataStore(
    () => store(false),
    { optimisticConcurrency: true, pagination: true, filter: true, softDelete: false },
  )
  describeDataStore(
    () => store(true),
    { optimisticConcurrency: true, pagination: true, filter: true, softDelete: true },
  )
}
