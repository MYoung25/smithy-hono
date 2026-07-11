---
id: realtime
title: 'Design: @live Realtime Notify-Hub'
sidebar_label: Realtime notify-hub
sidebar_position: 2
---

# Design: `@live` Realtime Notify-Hub Support for smithy-hono Generated Services

## 0. Scope & summary

Three real downstream services — `parks`, `deep-dive`, and `point-city` — independently implement the **same** realtime pattern by hand, because the codegen gives them no working primitive for it:

> A **keyed notify hub**: one coordination point per entity (keyed by the resource id), holding **no durable state** (an external `DataStore` is the source of truth). After a committed write, the server pushes a **`{ id, version }` notification** to every subscriber for that key; clients reconcile by refetching against the monotonic `version` cursor they already track. Dropped pushes are non-lossy — the next push or a poll self-heals.

`parks` implements this with a Durable Object WebSocket relay; `deep-dive` and `point-city` — which deliberately avoid Durable Objects (free-plan / D1-only) — fall back to a hand-written SSE endpoint where **every connection independently polls D1 every 1.5 s**. All three are the same shape with a different transport and a different reason for the boilerplate.

This document proposes making that pattern **first-class**: one Smithy trait (`@live`), one generated-and-functional SSE endpoint (replacing today's copy-paste template), one store decorator that fires notify-on-commit, and one `RealtimeHub` runtime port with **two swappable backends** — a **polling hub** that runs anywhere (no DO; generalizes the deep-dive/point-city loop) and a **Durable-Object push hub** on Cloudflare (generalizes the parks relay). The runtime lives in a **new opt-in package, `@smithy-hono/realtime`**, so services that don't model `@live` never pull it in, and a service that does can pick its backend at deploy time without changing generated code. **No implementation is proposed here — design only.**

---

## 1. Current state (with file:line evidence)

### 1.1 The SSE codegen stops at a *template* — there is no working server

`SseEmitter` (triggered by `@sseEvent` structures, `traits.smithy:14-20`) generates two files (`SseEmitter.java:41-54`):

- **`events.gen.ts`** — Zod schemas, a discriminated `…Event` union, an **`…EventEmitter` interface whose only method is `emit(channelId, event): Promise<void>`** (`SseEmitter.java:104-107`), and a typed browser **`…EventSource`** client (`SseEmitter.java:109-156`). This half is functional and good.
- **`events.template.ts`** — explicitly *"TEMPLATE — copy to src/routes/events.ts and customise … NOT the live generated output"* (`SseEmitter.java:165-166`). It defines `createEventsRouter(eventBus)` but requires the consumer to supply an `EventBusWithSubscribe = …EventEmitter & { subscribe(channelId, handler): () => void }` (`SseEmitter.java:172-177`) — i.e. **the entire bus is left to the consumer to write.**

`@sseStream` (`traits.smithy:35-39`) only flips a `streaming: true` flag in the metadata registry so the security-headers middleware skips `Cache-Control: no-store` for the route — it emits no handler. So the generated realtime story today is: typed events + typed client + *"go build a bus yourself."*

### 1.2 Every downstream service builds the same bus, because an in-memory one can't span isolates

- **deep-dive** — `src/routes/sse.ts`: a hand-written `GET /api/games/:gameId/events` whose comment states the reason directly — *an in-memory event bus cannot span Cloudflare Workers isolates, so each connection polls the `DataStore` every ~1.5 s* for a `version` change and emits `game:updated { gameId, version }`. Client `web/src/useGame.ts` refetches `GetGame` on any newer version, with a 10 s poll safety net.
- **point-city** — `src/routes/sse.ts` + `web/src/useGame.ts`: byte-for-byte the same pattern (poll D1 for `version`, emit `{ gameId, version }` hints, client version-guards and refetches). `wrangler.toml` explicitly says *"no Durable Objects, no KV — just D1."*
- **parks** — `src/realtime/GameRoom.ts`: a Durable Object addressed `idFromName(gameId)` that holds **no state** and fans out over hibernating WebSockets; `src/realtime/broadcastStore.ts`'s `withBroadcast(store)` decorates the two `seq`-advancing store seams (`commitAction`, `startGame`) and, after a committed D1 write, `fetch`es the game's DO `/broadcast`. Clients reconcile via `GetEvents(sinceSeq)`.

Common denominator across all three: **key = the entity id** (which is already the `DataStore` key *and* the SSE channel id), **source of truth = `DataStore` / D1**, **cursor = the `version` the store already manages** (`@persisted.optimisticConcurrency`, `traits.smithy:57-58`), **payload = a version hint** (deep-dive/point-city) or a record frame (parks), **fan-out = one-writer → many-readers**, **loss-tolerant by construction**. None need CRDT/OT, presence, per-connection server state, or a server tick.

### 1.3 There is no post-commit seam and no realtime port

- **CRUD emits only *pre*-write hooks.** `CrudEmitter`'s `…Hooks` interface is `beforeCreate` / `afterRead` / `beforeUpdate` / `beforeDelete` / `filterList` (`CrudEmitter.java:232-254`); the store writes happen at `CrudEmitter.java:433` (create/put), `:473`/`:482` (update), `:493` (delete) with **no `afterCommit` notification point**. Nothing fires when a write lands.
- **No realtime runtime port anywhere.** The only data port is `DataStore<T>` (`data-core/src/index.ts`) — row semantics, no pub/sub. The one Durable Object in the repo (`adapter-cf/src/durableObject.ts`, `SecurityDurableObject`) is a bespoke rate-limit/nonce serial counter using `ctx.storage` + alarms; it is **not** a fan-out hub and has no WebSocket/subscribe surface (repo-wide `websocket` search finds only Vite HMR configs).
- **deploy-cf can already *bind* a DO but not *derive* one.** `DurableObjectSpec { name, className, migrationTag }` exists in `deploy-cf/src/config.ts` and `wrangler.ts` renders `[[durable_objects.bindings]]` + `[[migrations]]` from a **hand-authored** `DeployConfig` — nothing derives the binding from the model, and no class source is generated.

**Net:** the pattern is validated by three production consumers, but the codegen provides typed events + a typed client and then hands the consumer a "write your own isolate-spanning bus" template. The recurring hand-written `sse.ts` *is the missing feature.*

---

## 2. Proposed abstraction

Four coordinated pieces: (A) a model convention (`@live`), (B) a `RealtimeHub` port with swappable backends, (C) a **functional** generated endpoint + a notify-on-commit store decorator, (D) model→deploy wiring. Design goals: the generated code is **backend-agnostic** (poll vs DO chosen at deploy time), the security pipeline is **unchanged in spirit** (subscribe is an authenticated, authorized route like any other), and a handler author writes **zero** realtime plumbing.

### 2.A Model convention: `@live` trait on a `@persisted` resource

Add a service-owned trait next to the others in `traits/` (mirroring `SseStreamTrait`, `PersistedTrait`):

```smithy
// model/traits.smithy (new)
/// Marks a @persisted resource as realtime-observable. Generates a functional SSE
/// subscribe endpoint keyed by the resource id, and wires notify-on-commit so a
/// successful write pushes a `{ id, version }` notification to that key's subscribers.
/// The store's monotonic `version` is the reconcile cursor; clients refetch on a newer
/// version. Backend (polling vs Durable Object push) is a deploy-time choice — the
/// generated code targets the RealtimeHub port, not a specific backend.
@trait(selector: "resource [trait|com.smithyhono#persisted]")
structure live {
    /// Channel key member; default = the resource identifier member (the DataStore key).
    keyMember: String

    /// Event `type` emitted on commit; default = "<resource>:updated".
    eventType: String

    /// Emit lifecycle transition events (created/deleted) in addition to updated. Default false.
    lifecycleEvents: Boolean

    /// Opt in to record-carrying frames ({records, version}) instead of version-only
    /// hints. Only valid when the resource has no per-recipient redaction, and only on
    /// the Durable Object (push) backend — the polling backend cannot carry records
    /// (withLiveNotify throws if pushRecords is paired with polling). Default false.
    pushRecords: Boolean
}
```

`@live` **only** adds an observation channel; it changes neither the resource's operations nor its persistence. It composes with `@persisted` (which already owns the `version` cursor via `optimisticConcurrency`, `traits.smithy:57-58`) and `@requiresAuth` (which gates the subscribe route). The selector requires `@persisted` because the cursor + store key the pattern depends on come from there — an unpersisted resource has no `version` to reconcile against, which the validator enforces (§below).

**Validator** (`validators/LiveResourceValidator.java`, mirroring `PersistedResourceValidator`): `@live` requires `@persisted`; `keyMember` (or the default id member) must be a resource identifier; `pushRecords: true` requires the read op's output to be non-redacted (heuristic: the entity type equals the stored type, no `@sensitive`/redaction hook) — otherwise error, because you cannot broadcast one record body to recipients who must see different projections (the exact reason deep-dive can only send hints).

### 2.B Runtime port: `RealtimeHub` with two backends (the opt-in package)

Add a single narrow port in the **new `@smithy-hono/realtime` package**, generalizing the existing `…EventEmitter.emit(channelId, event)` (`SseEmitter.java:104-107`) into a subscribe+notify pair:

```ts
// @smithy-hono/realtime — src/hub.ts
export interface RealtimeHub<E = { type: string; data: unknown }> {
  /** Push an event to every current subscriber of `channelId`. Best-effort, non-throwing. */
  notify(channelId: string, event: E): Promise<void>
  /** Attach a subscriber; returns an unsubscribe fn. The endpoint drives the transport. */
  subscribe(channelId: string, onEvent: (event: E) => void): () => void | Promise<void>
}
```

The generated `…EventEmitter` interface (`events.gen.ts`) becomes a **structural super-type** of `RealtimeHub` (both have `notify`/`emit` over `(channelId, event)`), so the two agree by construction and existing `events.gen.ts` consumers keep compiling.

Two backends implement the port; **which one runs is a deploy choice, not a codegen choice**:

1. **`PollingHub` (`@smithy-hono/realtime`, runs anywhere — no DO).** Generalizes the deep-dive/point-city loop: `subscribe(channelId, onEvent)` opens a `DataStore`-polling loop that reads the record's `version` every `intervalMs` and calls `onEvent({ type, data: { id, version } })` when it advances; `notify` is a no-op (the poll *is* the delivery). Because delivery is derived from a version poll and not from the pushed payload, the polling backend can only carry **version hints** — it cannot ship `@live.pushRecords` record frames (so `withLiveNotify` throws if the two are paired; record frames require the DO push backend below). This is the free-plan/D1-only path — it turns three hand-written `sse.ts` files into one library, with the same non-lossy, isolate-safe semantics. Constructed from the same `DataStore` the resource already uses (via a narrow `VersionSource` structural port so the hub imports no adapter).

2. **`DurableObjectHub` (`@smithy-hono/adapter-cf`, CF-only push).** Generalizes parks' `GameRoom`: a generated `export class <Resource>LiveHub extends DurableObject` addressed `idFromName(channelId)`, holding **no durable state**, that accepts SSE/WS subscribers and, on `notify` (an internal `fetch('/notify')` from the write path), fans the event out to all connected streams. Lives in `adapter-cf` alongside the existing `SecurityDurableObject` (`durableObject.ts`), reusing the `DurableObjectNamespaceLike` (`idFromName`/`get`) + `fetch`-dispatch discipline already proven there. This is the true push path (no poll latency, no per-client D1 reads).

Both satisfy `RealtimeHub`, so the generated endpoint and the store decorator (§2.C) are written **once** against the port; the app wires whichever backend its deployment supports.

### 2.C Generated endpoint + notify-on-commit decorator

Replace the copy-paste `events.template.ts` (`SseEmitter.java:160-198`) with a **functional** generated router for `@live` resources, and add the commit seam CRUD lacks.

- **`<resource>.live.gen.ts`** — a real `create<Resource>LiveRouter(hub: RealtimeHub, store: DataStore<Entity>)` that mounts `GET /<resource>/:id/events`, resolves the channel key (`@live.keyMember` / id member), runs the **same auth + authorize middleware the resource's read op uses** (so subscribing is gated exactly like reading — see §4), then — **when the `@persisted` resource declares `ownerField`/`tenantField`** — reproduces the read op's **resource-tier owner/tenant scope**: `const existing = await store.get(id, scopeFrom(c))` and throws the resource's bound 404 NotFound when null, BEFORE opening the channel. Only then does it `streamSSE`, bridging `hub.subscribe(id, …)` to `stream.writeSSE` and unsubscribing on abort. This is the current template (`SseEmitter.java:177-195`) made concrete and hub-backed, with the auth **and** entitlement gate added.

  **Why the store param + the guard (the IDOR fix).** The op-tier `authorize()` middleware only checks the read *permission*; the `RealtimeHub` is an app singleton and cannot carry the request principal, so op-tier auth alone lets a caller holding the read permission subscribe to a *different* owner/tenant's channel (they'd get 404 on `GetTodo /todos/victimId` yet still receive `victimId`'s version-advance stream). Mirroring `CrudEmitter.emitRead`'s `store.get(id, scopeFrom(c))` inside the router closes this: cross-owner/tenant subscribe fails closed (404, existence not leaked), exactly like the read op. The router therefore takes the **RAW scoped store** for a stable signature (guard emitted only when scoped; the emitter also copies `CrudEmitter`'s fail-closed `scopeFrom(c)` helper, gated on the declared owner/tenant keys). For an **unscoped** resource (neither `ownerField` nor `tenantField`, or `allowUnscoped: true`) no guard is emitted, but the emitter applies the same advisory as `CrudEmitter.warnIfUnscoped` — a build WARNING (or a hard failure under `enforceResourceScoping`) plus a DANGER note in the generated file's JSDoc — because an authenticated `@live` resource without owner/tenant scoping exposes its event channel to every authenticated caller holding the read permission. It composes with the existing typed `…EventSource` client (`SseEmitter.java:109-156`) unchanged.

- **`withLiveNotify(store, hub, opts)` store decorator** (`@smithy-hono/realtime`) — the parks `withBroadcast` generalized. Wraps a `DataStore<T>` and, **after** `create`/`put`/`update`/`delete` resolve successfully, calls `hub.notify(key, { type: eventType, data: { id: key, version: saved.version } })` (or a `{ records, version }` frame when `@live.pushRecords`). Because it decorates the port, it fires for **both** the generated `createDefault<Resource>Operations(store, …)` factory (`CrudEmitter.java:298-300` takes the store) **and** any hand-written ops — with no change to `CrudEmitter` and no new hook. The write remains the commit of record; notify is post-commit and best-effort (a dropped notify is recovered by the client's poll/refetch, exactly as today).

- **Wiring is one line at composition time**, matching how stores/ports are already injected (ARCH-05): `const liveStore = withLiveNotify(store, hub, opts); const ops = createDefault<Resource>Operations(liveStore, hooks)` and `app.route('/', create<Resource>LiveRouter(hub, store))`. Note the router receives the **RAW `store`** (its entitlement guard must run on the un-decorated read path), while the ops factory receives the **notify-decorated `liveStore`**. The metadata registry gains a `live: true` route class so the security-headers middleware skips `no-store` (reusing the exact `@sseStream` mechanism, `traits.smithy:35-37`) — `@live` implies `@sseStream` for its endpoint.

### 2.D Model→deploy wiring

When the DO backend is selected, deploy-cf must bind + migrate the generated hub class. Emit a manifest entry per `@live` resource (binding name `= <RESOURCE>_LIVE`, `className = <Resource>LiveHub`, a migration tag) that feeds the existing `DurableObjectSpec` (`deploy-cf/src/config.ts`) so `wrangler.ts` renders the `[[durable_objects.bindings]]` + `[[migrations]]` blocks it already knows how to render — the operator no longer hand-authors them. For the polling backend, no binding is emitted (nothing to provision) — the free-plan path stays free-plan.

---

## 3. Per-backend implementation sketch

| Concern | `PollingHub` (anywhere, no DO) | `DurableObjectHub` (Cloudflare) |
|---|---|---|
| Package | `@smithy-hono/realtime` | `@smithy-hono/adapter-cf` (with generated class) |
| Delivery | each subscriber polls `DataStore.get` for `version` | write path `fetch`es DO `/notify`; DO fans out |
| State held | none (ephemeral cursor per connection) | none (ephemeral socket set) |
| Latency | `intervalMs` floor (~1.5 s) | immediate on commit |
| Per-entity DB load | N subscribers × poll | one notify, zero read amplification |
| Provisioning | none | `[[durable_objects.bindings]]` + migration (auto-derived, §2.D) |
| Transport | SSE | SSE or WS hibernation (parks-style) |
| Generalizes | deep-dive/point-city `sse.ts` | parks `GameRoom` + `withBroadcast` |

- **`PollingHub`** de-risks first: it needs no new platform capability, works on all deploy targets (node/cf/aws), and immediately deletes the three hand-written `sse.ts` files. It is the *correctness baseline* — the DO hub is a pure latency/scale optimization on top of the same port and semantics.
- **`DurableObjectHub`** reuses `adapter-cf`'s DO discipline: the `DurableObjectNamespaceLike` (`idFromName`/`get`) structural port and `fetch`-dispatched paths from `securityStores.ts`/`durableObject.ts`, plus WebSocket hibernation for the true parks shape. It never touches `ctx.storage` (the hub is stateless), so its migration is `new_sqlite_classes`-free.
- Both are validated the same way the repo validates every port (ARCH-01): structural `*Like` port → in-memory fake → shared conformance suite → real backend, so `PollingHub` and `DurableObjectHub` are provably interchangeable behind `RealtimeHub`.

---

## 4. Composition with auth, the cursor, redaction, and headers

This is the crux: a realtime channel must not become an unauthenticated read side-channel.

- **Subscribe is an authorized route.** The generated `create<Resource>LiveRouter` reuses the resource's **read-op** auth scheme + `authorize(...)` middleware (the same `@requiresAuth`-driven `authenticate` → op-tier `authorize` chain `RouteEmitter` already emits before handlers). A caller who cannot `GetGame` cannot subscribe to its events. For per-entity authorization (only seated players may watch — parks checks `findPlayerByTokenHash` before forwarding), the router reproduces the resource's **owner/tenant scope** against the channel key: when `@persisted` declares `ownerField`/`tenantField` (`traits.smithy:60-64`) the router does `store.get(id, scopeFrom(c))` and 404s on null before subscribing, so tenant/owner scoping extends to the socket. **This is now implemented** (`LiveEmitter` mirrors `CrudEmitter.emitRead`'s `scopeFrom(c)` guard and takes the scoped store; op-tier `authorize` alone was insufficient because the app-singleton hub cannot carry the principal — a permission-holding but cross-scope caller could otherwise attach). **AuthZ + the entitlement guard both happen before `hub.subscribe`, so an unauthorized or cross-owner/tenant caller never attaches.**
- **The cursor is the existing `version`.** No new sequence concept: the notification carries `{ id, version }`, the client version-guards (`if (v > known) refetch()`) exactly as deep-dive/point-city already do, and reconnect/refetch backstops any dropped push. `@live` is non-lossy *because* it reuses the CAS `version` the store already maintains.
- **Redaction stays server-side (default `hint` mode).** The default payload is a **version hint**, not the record — so each subscriber refetches its own server-redacted view (deep-dive hides face-down tiles per player; parks redacts hidden state). `@live.pushRecords` is opt-in and validator-gated to non-projected resources only: `LiveResourceValidator` now **ERRORs** when `pushRecords: true` on a resource carrying either machine-detectable per-recipient projection signal — owner/tenant scoping (`@persisted.ownerField`/`tenantField`, the row is itself a per-recipient projection) **or** any `@sensitive`-reachable read-output member; the residual `afterRead`-hook case (hooks aren't statically detectable) stays a DANGER warning in both the validator and the generated file's JSDoc. `pushRecords` is additionally **push-backend-only**: the `PollingHub` derives its notifications from a version poll and cannot carry a record body, so `withLiveNotify` **throws** if `pushRecords` is paired with the polling backend (backend is a deploy-time choice, unknown at generation time, so this is a runtime guard rather than a codegen error) — only the Durable Object push backend can ship record frames. When off, the hub literally cannot leak a projection the caller isn't entitled to, because it ships no record bytes.
- **Security headers.** `@live` implies the `@sseStream` route class (`traits.smithy:35-37`), so the security-headers middleware already skips `Cache-Control: no-store` on the stream — no new pipeline branch.
- **Notify is post-commit and best-effort.** `withLiveNotify` fires *after* the store write resolves; a failed/dropped notify never fails the write and is recovered by the client's version-guarded poll/refetch — the same self-healing property all three repos rely on today.

---

## 5. Backwards-compatibility notes

- **Purely additive at the model layer.** A resource without `@live` is byte-for-byte unchanged: no new emitter fires, `CrudEmitter` is untouched (the notify seam is a *decorator around the store*, not a change to the factory, `CrudEmitter.java:298-300`), and `events.gen.ts`/`events.template.ts` still emit as today for `@sseEvent` structures. Existing snapshots don't churn.
- **The `…EventEmitter` interface is preserved, not forked.** `RealtimeHub` is structurally compatible with the generated `emit(channelId, event)` surface (`SseEmitter.java:104-107`); the template file can remain for the non-keyed/custom-bus case, while `@live` supplies the functional path.
- **New opt-in package.** `@smithy-hono/realtime` is a new dependency pulled in **only** when a model uses `@live`; the DO backend lives in `adapter-cf` as a new named export (no breaking change to existing exports). Free-plan/no-DO services adopt the `PollingHub` and pull in **no** Durable Object dependency — the deep-dive/point-city constraint is honored.
- **Deploy config is additive.** `DurableObjectSpec` already exists (`deploy-cf/src/config.ts`); `@live` only *feeds* it for the DO backend. Polling deployments render no new bindings.
- **Adoption is incremental per service.** parks migrates its `withBroadcast`→`withLiveNotify` and `GameRoom`→generated `DurableObjectHub`; deep-dive/point-city delete `sse.ts` and adopt the generated router + `PollingHub`, keeping their free-plan posture, and can later flip to the DO backend by changing deploy config alone.

---

## 6. Package layout

Recommended split (answers "its own package?" — **yes for the runtime**, with one caveat):

- **`@smithy-hono/realtime` (new package).** The backend-agnostic core: `RealtimeHub` port, `PollingHub`, `withLiveNotify` store decorator, the SSE endpoint helper, the `VersionSource` structural port, and the conformance suite. Opt-in — nothing else depends on it. This is the package pulled in "if necessary."
- **`@smithy-hono/adapter-cf` (existing).** Gains the `DurableObjectHub` backend + the generated-hub base, next to the existing `SecurityDurableObject` — because it needs CF-specific types and belongs with the other DO code. Exported as a new named export.
- **`@smithy-hono/deploy-cf` (existing).** Gains model→`DurableObjectSpec` derivation for `@live` resources (§2.D).
- **Codegen (the plugin JAR).** The `@live` trait (`traits/LiveTrait.java`), validator (`validators/LiveResourceValidator.java`), and a new `LiveEmitter` (`writers/`) **cannot** be a separate package — it is one Smithy plugin — but it is fully gated: nothing emits unless `@live` is present, and the generated code imports from the opt-in `@smithy-hono/realtime` package. So a service that doesn't model `@live` neither emits realtime code nor acquires the dependency.

The asymmetry is inherent to the architecture: the **runtime** genuinely wants to be a pulled-in-if-needed package (your instinct is right, and it doubles as the home for the isolate-safe `PollingHub` the D1-only services want); the **codegen** is one JAR and instead relies on trait-gating for the same "only present when used" property.

---

## 7. Phased rollout (implementation plan)

- **Phase L0 — Port + polling backend (no codegen).** Land `@smithy-hono/realtime`: `RealtimeHub`, `VersionSource`, `PollingHub`, `withLiveNotify`, the SSE endpoint helper, an in-memory fake, and the conformance suite (mirroring `data-core/src/conformance.ts`). Ships value immediately — deep-dive/point-city can replace their hand-written `sse.ts` against a stable library **before any trait exists**. This is the correctness baseline and de-risks the semantics on the friendliest (no-platform-dependency) path.
- **Phase L1 — `@live` trait + validator + `LiveEmitter` (polling target).** Add `LiveTrait` in `traits/`, `LiveResourceValidator` (mirroring `PersistedResourceValidator`), and `LiveEmitter` emitting `<resource>.live.gen.ts` (the functional router + the `withLiveNotify` wiring), gated on `@live`. Wire `live: true` into the metadata registry route class (reuse the `@sseStream` mechanism). Golden-file/snapshot tests for the new emitted files; assert non-`@live` snapshots don't churn.
- **Phase L2 — Auth/authz on subscribe.** Emit the read-op auth scheme + `authorize`/`requireResourcePolicy` gate on the subscribe route (§4), and thread `@persisted` owner/tenant scoping into the channel-key check. Tests: unauthorized subscribe → 401/403; cross-tenant subscribe → 403.
- **Phase L3 — Migrate the two D1-only services.** Replace deep-dive/point-city `sse.ts` + `web/src/useGame.ts` wiring with the generated router + `PollingHub`. Proves the generated path reproduces the existing behavior on real services, keeping their free-plan posture (no DO). This is the acceptance gate for L0–L2.
- **Phase L4 — Durable Object push backend (Cloudflare).** Emit the `<Resource>LiveHub extends DurableObject` class + add `DurableObjectHub` to `adapter-cf` (SSE first; WS hibernation second), addressed `idFromName(channelId)`, stateless fan-out over the `DurableObjectNamespaceLike`/`fetch` discipline from `securityStores.ts`. Validate on miniflare (the existing `live.miniflare` convention in `adapter-cf`). The generated router/decorator are unchanged — only the injected backend swaps.
- **Phase L5 — Deploy derivation.** Emit the `@live`→`DurableObjectSpec` manifest and consume it in `deploy-cf` (`config.ts`/`wrangler.ts`/`bin/deploy.ts`) so the DO binding + migration are model-derived, not hand-authored (§2.D). A deployment flips poll→push by config alone.
- **Phase L6 — Record-frame mode + parks migration.** The record-frame **capability landed in 0.2.0**: the `@live.pushRecords` trait member, its validator gate (ERRORs on `@sensitive`-reachable output or owner/tenant scoping; DANGER-warns on the residual `afterRead`-hook case), the `LiveEmitter` codegen wiring + DANGER JSDoc, and the `{ records, version }` runtime frame — including the `withLiveNotify` runtime guard that throws when `pushRecords` is paired with the record-incapable polling backend (record frames require the DO push backend). What **remains** of L6 is the external **parks migration** (`withBroadcast`→`withLiveNotify`, `GameRoom`→generated `RealtimeDurableObject`) to retire the last hand-written realtime code and prove the record-carrying path end-to-end on a real service. That migration is post-publish validation — it needs the published/linked package — so it is the same class of deferred, out-of-repo acceptance work as L3, not a codegen gap.
- **Phase L7 — Publish as `0.2.0`.** Realtime is the first net-new *capability* since the `0.1.x` line (which has only carried patch-level security/adversarial-review fixes), so it warrants a minor bump. Bump every workspace package from `0.1.6` → `0.2.0` (all 11 packages are lockstep-versioned today, plus the **new** `@smithy-hono/realtime` published at `0.2.0`). Because `build.gradle.kts:17-19` derives the Gradle/Maven artifact `version` from `packages/security-core/package.json`, that file's bump also versions the codegen plugin JAR — so the plugin and the runtime ship the same `0.2.0`. Steps: (1) bump all `packages/*/package.json` versions + refresh `package-lock.json`; (2) add `@smithy-hono/realtime` to the workspace and publish targets; (3) run the green gate (`gradlew test`) — **not** `gradlew build`, which is red on `main` at `npmBuild` for pre-existing reasons unrelated to this change; (4) publish npm packages + the plugin to the GitLab Package Registry (`build.gradle.kts:68`); (5) tag `v0.2.0` and note realtime as the headline feature in release notes. Gate: L7 ships only after L3 (the two-service migration acceptance gate) is green — record-frame mode (L6) can trail into a later `0.2.x` if needed, since `@live.pushRecords` is opt-in and additive.

---

### Key files this design touches (for implementers)

- **New package:** `packages/realtime/src/{hub,pollingHub,withLiveNotify,endpoint,conformance,index}.ts` (+ tests).
- **Codegen:** new `src/main/java/com/smithyhono/traits/LiveTrait.java`, `src/main/java/com/smithyhono/validators/LiveResourceValidator.java`, `src/main/java/com/smithyhono/writers/LiveEmitter.java`; edits to `HonoCodegenPlugin.java` (gather `@live` resources, slot the emitter — mirrors the `@persisted`/`CrudEmitter` wiring), `writers/MetadataRegistryEmitter.java` (`live` route class), `model/traits.smithy`.
- **CF backend:** `packages/adapter-cf/src/{durableObjectHub,index}.ts` (new export beside `durableObject.ts`), reusing `ports.ts`/`securityStores.ts` DO discipline.
- **Deploy:** `packages/deploy-cf/src/{config,wrangler,bin/deploy}.ts` (model-derived `DurableObjectSpec`).
- **Downstream migrations (validation, not this repo):** deep-dive/point-city `src/routes/sse.ts`; parks `src/realtime/{GameRoom,broadcastStore}.ts`.
