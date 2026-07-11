/**
 * The narrow structural storage port the DynamoDB-backed stores depend on.
 *
 * The stores (session / rate-limit / nonce) are written ONLY against this
 * interface — they never import `@aws-sdk/*`. Two implementations satisfy it:
 *
 *   - {@link createDynamoTablePort} (in `./dynamoPort.ts`) — the REAL port,
 *     mapping these four ops onto DynamoDB PutItem/GetItem/UpdateItem/DeleteItem
 *     with a `ConditionExpression` + a `version` attribute for optimistic
 *     concurrency. Takes a structural `DynamoSendLike` so the package typechecks
 *     and tests WITHOUT installing the AWS SDK (ARCH-01, dependency discipline).
 *
 *   - {@link FakeDynamoTablePort} (in `./test-support.ts`) — an in-process `Map`
 *     honoring the SAME conditional/CAS atomicity synchronously (correct under
 *     JS's single thread, exactly like the security-core memory stores), so the
 *     conformance suites run locally with root-hoisted tooling only.
 *
 * Items are plain `Record<string, unknown>` (the DocumentClient marshalls these
 * to/from AttributeValues; the fake stores them as-is). Every store namespaces
 * its own partition keys, so one physical table can back all three.
 */

/** A single item's primary key — the partition-key string value. */
export interface ItemKey {
  /** Partition-key attribute value (already namespaced by the store). */
  pk: string
}

/**
 * The minimal atomic op set the stores need. The real port maps these onto
 * DynamoDB; the fake implements them over a `Map`. All ops are keyed by `pk`.
 */
export interface DynamoTablePort {
  /** Read an item by key, or `null` if absent. */
  getItem(key: ItemKey): Promise<Record<string, unknown> | null>

  /**
   * Write an item. With `{ ifNotExists: true }` the write is conditional on the
   * partition key NOT already existing (`attribute_not_exists(pk)`); it returns
   * `false` when the condition fails (item already present) and `true` when it
   * stored. Without the option it is an unconditional upsert returning `true`.
   *
   * The item MUST carry the `pk` attribute; stores also set a `ttl` attribute
   * (epoch seconds) for DynamoDB TTL eviction where relevant.
   */
  putItem(item: Record<string, unknown>, opts?: { ifNotExists?: boolean }): Promise<boolean>

  /**
   * Optimistic-concurrency compare-and-set. Reads the current item (or `null`),
   * runs `mutate`, and writes the result conditional on the item's `version`
   * being unchanged since the read (`attribute_not_exists(pk)` for a fresh
   * insert). Returns `true` if the write committed, `false` on a version
   * conflict — the caller (`./stores/rateLimit.ts`) retries on `false`.
   *
   * `mutate` returns the next item (which the port stamps with an incremented
   * `version`), or `null` to abort the write (commit nothing, returns `true`).
   * The `version` attribute is managed entirely by the port; `mutate` must not
   * set it.
   */
  updateConditional(
    key: ItemKey,
    mutate: (current: Record<string, unknown> | null) => Record<string, unknown> | null,
  ): Promise<boolean>

  /** Delete an item by key. Idempotent (no error if absent). */
  deleteItem(key: ItemKey): Promise<void>
}

/** The `version` attribute name the CAS path reads/writes. */
export const VERSION_ATTR = 'version'
/** The TTL attribute name (epoch SECONDS) — must match the table's TTL config. */
export const TTL_ATTR = 'ttl'
/** The partition-key attribute name. */
export const PK_ATTR = 'pk'
