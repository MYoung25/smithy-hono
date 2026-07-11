---
id: key-lifecycle
title: S2S signing-key lifecycle
sidebar_label: Key lifecycle
sidebar_position: 3
---

# S2S Signing-Key Lifecycle — Operator Runbook (OPS-03)

This is the runbook for provisioning, rotating, and revoking the HMAC signing keys
that service-to-service (S2S) clients use with the `SH-HMAC-SHA256` scheme
(`plan/security/07-request-signing-hmac.md`, canonicalization spec
`plan/security/07a-canonicalization-spec.md`).

It is backed by:

- **Library** — `@smithy-hono/key-tool`: backend-agnostic lifecycle operations
  (`provisionClient`, `rotateClient`, `revokePreviousKey`, `revokeClient`) plus
  `generateHmacSecret` / `mintKeyId`. The library is web-standard and portable; it
  drives a structural `WritableKeyBackend`.
- **CLI** — `key-tool` (node-only), a thin wrapper that wires the Node Redis
  backend.
- **Per-adapter write backends**:
  - `@smithy-hono/adapter-node` → `RedisKeyBackend` — **full** end-to-end
    (material + client→keyId directory both in Redis). This is the adapter with a
    live conformance test, so this runbook is verifiable against it.
  - `@smithy-hono/adapter-aws` → `AwsKeyBackend` — **full** (material in Secrets
    Manager via a writable structural port; directory via a structural port, e.g.
    DynamoDB).
  - `@smithy-hono/adapter-cf` → `CfKeyBackend` — **directory plane only** is
    writable in Workers KV; **key material is provisioned out-of-band** because
    Workers secrets are read-only at request time (see "Cloudflare" below).

---

## The key model (read this first)

A client signs every request with one `keyId`, carried in the `Authorization`
header. The server's `verifySignature` resolves the key purely by that keyId:
`secrets.getSigningKey(parsed.keyId)` — **any keyId whose material is still present
verifies, independent of which key is "current"**
(`packages/security-core/src/signing/verifySignature.ts`, step 6 "SIGN-05 key
resolution"). The client→keyId directory only decides which keyId NEW signatures
should use (`getCurrentKeyId`).

That is what makes a zero-downtime rotation possible:

```
provision   directory: { current: K1 }                material: { K1 }
rotate      directory: { current: K2, previous: K1 }   material: { K1, K2 }   ← overlap window
revoke-prev directory: { current: K2 }                 material: { K2 }
```

During the **overlap window** both K1 and K2 are present, so a request already in
flight (signed with K1) still verifies, while new requests use K2. The window is
closed explicitly by `revoke-previous`, which deletes K1's material.

**Overlap duration:** keep the previous key alive for at least the signing
acceptance window (`config.signing.acceptanceWindowSeconds`, default **300 s**) —
a request older than that is already rejected on the timestamp check, so once that
window has fully elapsed since you moved the pointer, no valid in-flight request
can still be using K1. A few minutes of margin is prudent.

---

## Onboarding a new client (provision)

```sh
export REDIS_URL=redis://localhost:6379
npx key-tool provision client-a
```

Output (printed **once** — the material is never recoverable from the backend):

```json
{
  "action": "provision",
  "clientId": "client-a",
  "keyId": "client-a.3f9c1a2b4d5e",
  "material": "<base64 HMAC secret>"
}
```

1. Distribute `keyId` + `material` to the client over a secure channel (the client
   imports the base64 material as an HMAC-SHA-256 signing key and sets `keyId` in
   its `Authorization` header).
2. The server side needs the new keyId reflected in its `currentKeyByClient` map
   (Node `NodeSecretProvider`) — with `RedisKeyBackend` the directory entry written
   here is the source of truth; point the provider's `currentKeyByClient` at the
   directory's `current` for each client, or rebuild it from the directory on
   deploy.

Library equivalent:

```ts
import { RedisKeyBackend } from '@smithy-hono/adapter-node'
import { provisionClient } from '@smithy-hono/key-tool'

const backend = new RedisKeyBackend(createRedisPort(redis))
const { keyId, material } = await provisionClient(backend, { clientId: 'client-a' })
```

---

## Rotating a client's key (with overlap)

```sh
npx key-tool rotate client-a
```

```json
{
  "action": "rotate",
  "clientId": "client-a",
  "newKeyId": "client-a.aa11bb22cc33",
  "previousKeyId": "client-a.3f9c1a2b4d5e",
  "material": "<new base64 secret>"
}
```

What happens, in order (`rotateClient`):

1. The **new** key's material is written first (so it verifies the instant the
   pointer moves).
2. The directory pointer moves: `current = newKeyId`, `previous = oldKeyId`. The
   old material is **left in place** — this is the overlap window.
3. A **`key.rotate` audit event** is emitted through the injected `AuditSink`
   (`buildAuditEvent({ type: 'key.rotate', ... })` + `emitAudit(...)`), with
   `detail: { action: 'rotate', clientId, newKeyId, previousKeyId }`. The CLI wires
   the Node stdout audit sink, so the rotation appears as a `kind: 'audit'` JSON
   line your log shipper already collects.

Rollout:

1. Run `rotate`, distribute the new `keyId` + `material` to the client.
2. The client switches to the new key. In-flight requests still using the old key
   keep verifying (overlap).
3. After ≥ the acceptance window (default 300 s) + margin, close the overlap:

```sh
npx key-tool revoke-previous client-a
```

This deletes the previous key's material and clears `previous`. From then on the
old keyId resolves to `null` → uniform 401.

---

## Revoking a client (offboarding / compromise)

To reject a client immediately and entirely:

```sh
npx key-tool revoke client-a
```

`revokeClient` deletes **both** the current and previous key material (so every
signature from the client is rejected at once) and tombstones the directory entry,
then emits a `key.rotate` event with `detail.action = 'revoke'`. There is no
overlap here — this is intentional for compromise response.

For a planned offboarding where in-flight requests should still drain, prefer
`rotate` then `revoke-previous` after the window, and stop issuing new material.

---

## Cloudflare specifics

On Workers, key **material** is a Workers secret and is **read-only at request
time**. So `CfKeyBackend`:

- **directory plane (Workers KV)** — `getDirectoryEntry` / `putDirectoryEntry` work
  in-band; the lifecycle library can move the current→previous pointer at runtime.
- **material plane (out-of-band)** — `putKeyMaterial` / `deleteKeyMaterial` throw
  with an instruction. Publish/rotate/revoke material via the control plane:

  ```sh
  # provision / rotate material
  wrangler secret put SIGNING_KEY_<keyId>      # paste the base64 material
  # revoke material
  wrangler secret delete SIGNING_KEY_<keyId>
  ```

  (or the equivalent Cloudflare API call). Then move the KV directory pointer with
  the library. Order: publish new material out-of-band first, then rotate the
  pointer, then (after the window) delete the old secret.

## AWS specifics

`AwsKeyBackend` is full lifecycle: material lives in Secrets Manager (writable via
the structural `WritableSecretsSourceLike` — the consumer wires
`PutSecretValue`/`CreateSecret`/`DeleteSecret`), and the directory via a structural
`KeyDirectoryPortLike` (e.g. one DynamoDB item per client). The same
`provisionClient` / `rotateClient` / `revokePreviousKey` / `revokeClient` calls
apply.

---

## Verifying against live conformance

The Node path is verifiable against a real Redis:

```sh
docker run --rm -d -p 6379:6379 redis:7-alpine
export REDIS_URL=redis://localhost:6379

# CLI round-trip
npx key-tool provision client-a
npx key-tool rotate client-a            # emits a key.rotate audit line to stdout
npx key-tool current client-a           # { clientId, entry: { current: K2, previous: K1 } }
npx key-tool revoke-previous client-a   # entry: { current: K2 } (previous cleared)
```

Automated coverage (no Docker needed — in-process fake Redis port):

- `packages/key-tool/src/lifecycle.test.ts` — provision/rotate/revoke + the
  `key.rotate` emission + the overlap-window invariant (a signature made with the
  previous key still verifies after rotation, fails after `revoke-previous`).
- `packages/key-tool/src/redisBackend.test.ts` — the same flow end-to-end through
  the real `RedisKeyBackend` and a live `NodeSecretProvider` reading the same Redis
  material.

Run: `npm -w @smithy-hono/key-tool run test:ci`.
