/**
 * `withLiveNotify` — the notify-on-commit `DataStore` decorator.
 *
 * Generalizes parks' `withBroadcast`. Wraps a {@link DataStore} and, **after** a
 * mutating method (`create` / `put` / `update` / `patch` / `delete`) resolves
 * successfully, fires `hub.notify(channelId, event)` so subscribers of that
 * record's channel learn a committed write happened. Because it decorates the
 * port, it fires for both the generated `createDefault<Resource>Operations(store)`
 * factory and any hand-written ops — no change to CRUD codegen, no new hook.
 *
 * Semantics (pinned by the frozen contract):
 *  - **channelId** = `` `${opts.resource.toLowerCase()}:${id}` `` where `id` is
 *    the DataStore key (which is the record id / SSE channel id).
 *  - **payload**, hint mode (default): `{ type: eventType, data: { id, version } }`.
 *    Record mode (`pushRecords: true`): `{ type: eventType, data: { records: [saved], version } }`.
 *    `version` comes from the `Stored<T>` the store returns.
 *  - `delete` emits the reserved **terminal** {@link LIVE_DELETED_TYPE}
 *    (`"live:deleted"`) rather than the resource's update `eventType` with a
 *    `version: null` hint — a null-version hint is a no-op to a version-guarding
 *    client, whereas the delete type is a distinguished signal the endpoint turns
 *    into a final SSE frame + stream close. Payload still `{ id, version: null }`
 *    (hint mode) / `{ records: [], version: null }` (record mode).
 *  - **post-commit, best-effort**: notify runs after the write resolves and is
 *    awaited-then-swallowed, so a throwing / slow-rejecting hub never fails the
 *    write (clients recover via their version-guarded poll/refetch).
 *
 * `patch` is decorated as well as `update`: it is a committed write that advances
 * `version`, so subscribers must reconcile against it exactly like an `update`.
 */

import type {
  DataScope,
  DataStore,
  Stored,
} from '@smithy-hono/data-core'
import type { RealtimeEvent, RealtimeHub } from './hub.js'
import { LIVE_DELETED_TYPE } from './hub.js'

export interface LiveNotifyOptions {
  /** Resource name; lowercased into the channel key `` `${resource}:${id}` ``. */
  resource: string
  /** Event `type` emitted on commit (e.g. `"game:updated"`). */
  eventType: string
  /**
   * Emit record-carrying frames (`{ records, version }`) instead of version-only
   * hints (`{ id, version }`). Default false.
   *
   * **Client-side consumption contract** (mirrors {@link LIVE_DELETED_TYPE}'s
   * consumer contract; the client lives in the generated router/client, out of
   * this package):
   *  - **Record mode** (`pushRecords: true`): the client **APPLIES the `records`
   *    directly** into its local view and does **NOT** refetch — the frame IS the
   *    new state. `version` stays the reconcile cursor / ordering guard: apply a
   *    record only if its `version` is newer than what the client already holds
   *    (out-of-order or duplicate frames are dropped by this guard), exactly as a
   *    hint would have gated a refetch.
   *  - **Hint mode** (`pushRecords` falsy): the frame carries only `{ id, version }`;
   *    the client **refetches** its own (possibly redacted) projection of the
   *    record and reconciles against `version`.
   *
   * Record mode is only valid for **non-redacted** resources (the server-side
   * validator already enforces this — a redacted resource must stay in hint mode
   * so each subscriber refetches its own authorized projection rather than
   * receiving another subscriber's full record).
   *
   * Record mode **requires a push backend** — a hub whose {@link RealtimeHub.notify}
   * actually delivers the frame body (`createMemoryHub`, or adapter-cf's Durable
   * Object hub). It is **rejected at construction time** on a non-delivering
   * backend such as {@link createPollingHub} (see the guard in
   * {@link withLiveNotify}); a polling backend can only ship `{ id, version }`
   * hints, so silently accepting `pushRecords` there would drop every record frame.
   */
  pushRecords?: boolean
}

export function withLiveNotify<T>(
  store: DataStore<T>,
  hub: RealtimeHub,
  opts: LiveNotifyOptions,
): DataStore<T> {
  // Fail closed: `pushRecords` frames are delivered via `hub.notify`, so a
  // backend whose `notify` does not deliver (deliversNotify === false, e.g.
  // createPollingHub, whose poll loop only re-reads `version`) would silently
  // drop every record frame. Reject at construction rather than lose data at
  // runtime. Absent `deliversNotify` = assumed to deliver, so push backends
  // (memory, adapter-cf's Durable Object hub) are unaffected and need no change.
  if (opts.pushRecords === true && hub.deliversNotify === false) {
    throw new Error(
      'pushRecords requires a push backend (memory or Durable Object); ' +
        'createPollingHub cannot ship record frames — it delivers only ' +
        '{id,version} version hints via polling. Use the DO backend for ' +
        'pushRecords, or drop pushRecords and let clients refetch.',
    )
  }

  const resource = opts.resource.toLowerCase()
  const channel = (id: string): string => `${resource}:${id}`

  /** Fire-and-forget-safe: awaited, but a throw/rejection never propagates. */
  const emit = async (
    id: string,
    type: string,
    saved: Stored<T> | null,
    version: number | null,
  ): Promise<void> => {
    const data = opts.pushRecords
      ? { records: saved ? [saved] : [], version }
      : { id, version }
    const event: RealtimeEvent = { type, data }
    try {
      await hub.notify(channel(id), event)
    } catch {
      /* best-effort: a dropped notify is recovered by the client's poll/refetch */
    }
  }

  // R1-4: inherit the underlying store's FULL surface via the prototype chain —
  // `get`/`list`/`count` and any method beyond the `DataStore` interface (incl.
  // future optional methods) pass through untouched — then override only the
  // mutating methods that must notify. (A shallow `{ ...store }` spread would
  // silently drop prototype methods when the store is a class instance, which
  // the memory/D1/postgres adapters all are, so `Object.create` is used instead
  // of a spread to keep the decorator genuinely transparent.)
  const decorated = Object.create(store) as DataStore<T>

  decorated.create = async (
    key: string,
    value: T,
    scope: DataScope,
  ): Promise<Stored<T>> => {
    const saved = await store.create(key, value, scope)
    await emit(key, opts.eventType, saved, saved.version)
    return saved
  }

  decorated.put = async (
    key: string,
    value: T,
    scope: DataScope,
  ): Promise<Stored<T>> => {
    const saved = await store.put(key, value, scope)
    await emit(key, opts.eventType, saved, saved.version)
    return saved
  }

  decorated.update = async (
    key: string,
    value: T,
    expectedVersion: number | undefined,
    scope: DataScope,
  ): Promise<Stored<T>> => {
    const saved = await store.update(key, value, expectedVersion, scope)
    await emit(key, opts.eventType, saved, saved.version)
    return saved
  }

  decorated.patch = async (
    key: string,
    partial: Partial<T>,
    expectedVersion: number | undefined,
    scope: DataScope,
  ): Promise<Stored<T>> => {
    const saved = await store.patch(key, partial, expectedVersion, scope)
    await emit(key, opts.eventType, saved, saved.version)
    return saved
  }

  decorated.delete = async (
    key: string,
    expectedVersion: number | undefined,
    scope: DataScope,
  ): Promise<boolean> => {
    const deleted = await store.delete(key, expectedVersion, scope)
    if (deleted) {
      // R1-1: emit the reserved terminal type (not the update `eventType` with a
      // no-op null-version hint) so the endpoint closes the client's stream.
      await emit(key, LIVE_DELETED_TYPE, null, null)
    }
    return deleted
  }

  return decorated
}
