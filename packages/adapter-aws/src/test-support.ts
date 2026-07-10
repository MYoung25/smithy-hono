/**
 * In-process FAKE {@link DynamoTablePort} for local/CI testing WITHOUT DynamoDB.
 *
 * It honors the SAME conditional/CAS atomicity the real DynamoDB port provides,
 * SYNCHRONOUSLY over a `Map`. This is correct under JS's single thread for the
 * same reason the security-core memory stores are: each `async` method body runs
 * its read-modify-write to completion in one tick without interleaving, so a
 * burst of concurrent `consume`/`checkAndStore` calls is effectively serialized —
 * exactly the guarantee a strongly-consistent backend gives. That is what lets
 * the AWS stores pass the conformance suite's no-overspend / exactly-once checks
 * against this fake.
 *
 * Exported from the package's `./test-support` entry so a consumer can also run
 * the conformance suite against the fake in their own CI before wiring DynamoDB.
 */

import type { DynamoTablePort, ItemKey } from './port.js'
import { VERSION_ATTR } from './port.js'

export class FakeDynamoTablePort implements DynamoTablePort {
  private readonly map = new Map<string, Record<string, unknown>>()

  async getItem(key: ItemKey): Promise<Record<string, unknown> | null> {
    const item = this.map.get(key.pk)
    return item ? { ...item } : null // defensive copy (no shared references).
  }

  async putItem(item: Record<string, unknown>, opts?: { ifNotExists?: boolean }): Promise<boolean> {
    const pk = item.pk as string
    if (opts?.ifNotExists && this.map.has(pk)) return false // attribute_not_exists(pk) failed.
    this.map.set(pk, { ...item, [VERSION_ATTR]: 1 })
    return true
  }

  async updateConditional(
    key: ItemKey,
    mutate: (current: Record<string, unknown> | null) => Record<string, unknown> | null,
  ): Promise<boolean> {
    // Single-tick read-modify-write: no await between read and write, so this is
    // atomic under JS's event loop — the CAS version-guard can never actually
    // observe a conflict here, which is the correct strongly-consistent outcome.
    const current = this.map.get(key.pk) ?? null
    const result = mutate(current ? { ...current } : null)
    if (result === null) return true // deliberate no-op.
    const currentVersion = typeof current?.[VERSION_ATTR] === 'number' ? (current[VERSION_ATTR] as number) : 0
    this.map.set(key.pk, { ...result, pk: key.pk, [VERSION_ATTR]: currentVersion + 1 })
    return true
  }

  async deleteItem(key: ItemKey): Promise<void> {
    this.map.delete(key.pk)
  }
}

/** In-process FAKE {@link SecretsSourceLike} for tests — a plain secretId → string map. */
export class FakeSecretsSource {
  constructor(private readonly secrets: Record<string, string> = {}) {}
  set(secretId: string, value: string): void {
    this.secrets[secretId] = value
  }
  async getSecretString(secretId: string): Promise<string | null> {
    return this.secrets[secretId] ?? null
  }
}
