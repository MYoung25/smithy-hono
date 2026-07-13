/**
 * Integration test (OPS-03): the lifecycle library driving the REAL
 * `RedisKeyBackend` from `@smithy-hono/adapter-node`, over the in-process fake
 * Redis port. Proves the node adapter's write backend satisfies
 * {@link WritableKeyBackend} and that a live `NodeSecretProvider` reading the SAME
 * Redis material verifies the provisioned/rotated keys — including the overlap
 * window — and rejects a revoked key.
 */

import { describe, it, expect } from 'vitest'
import { createFakeRedisPort } from '@smithy-hono/adapter-node/test-support'
import { RedisKeyBackend, NodeSecretProvider, redisSecretSource } from '@smithy-hono/adapter-node'
import { importHmacKey, signRequest } from '@smithy-hono/security-core'
import { provisionClient, rotateClient, revokePreviousKey } from './lifecycle.js'

describe('RedisKeyBackend + NodeSecretProvider end-to-end', () => {
  it('provision → sign-old → rotate → both verify in overlap → revoke-previous → old fails', async () => {
    const port = createFakeRedisPort()
    const backend = new RedisKeyBackend(port)

    // A live verifier reading the SAME Redis material the backend writes.
    const provider = (current: Record<string, string>) =>
      new NodeSecretProvider(redisSecretSource(port), { currentKeyByClient: current })

    // 1. Provision client-a.
    const first = await provisionClient(backend, { clientId: 'client-a' })
    let p = provider({ 'client-a': first.keyId })
    expect(await p.getSigningKey(first.keyId)).not.toBeNull()
    expect(await p.getCurrentKeyId('client-a')).toBe(first.keyId)

    // Build a signature with the original key (an in-flight client).
    const bin = atob(first.material)
    const matBytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) matBytes[i] = bin.charCodeAt(i)
    const signKey = await importHmacKey(matBytes, ['sign'])
    const ts = Math.floor(Date.now() / 1000)
    const signed = await signRequest({
      method: 'GET',
      url: 'https://api.example.com/health',
      headers: { host: 'api.example.com', 'x-sh-timestamp': String(ts) },
      keyId: first.keyId,
      key: signKey,
      signedHeaders: ['host', 'x-sh-timestamp'],
      timestamp: ts,
    })
    const sigHex = signed.authorization.match(/signature=([0-9a-f]+)/)![1]
    const sigBytes = Uint8Array.from(sigHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)))
    const canonical = new TextEncoder().encode(signed.canonicalString)

    // 2. Rotate. New current; old kept in overlap.
    const rot = await rotateClient(backend, { clientId: 'client-a' })
    p = provider({ 'client-a': rot.newKeyId })
    expect(await p.getCurrentKeyId('client-a')).toBe(rot.newKeyId)

    // Both keys resolve during the overlap window; the OLD signature still verifies.
    const prevKey = await p.getSigningKey(first.keyId)
    const newKey = await p.getSigningKey(rot.newKeyId)
    expect(prevKey).not.toBeNull()
    expect(newKey).not.toBeNull()
    expect(await crypto.subtle.verify('HMAC', prevKey!, sigBytes, canonical)).toBe(true)

    // 3. Close the overlap — revoke previous. The old keyId is now unknown → null.
    await revokePreviousKey(backend, 'client-a')
    // Fresh provider (the per-instance import cache wouldn't see the deletion).
    const p2 = provider({ 'client-a': rot.newKeyId })
    expect(await p2.getSigningKey(first.keyId)).toBeNull()
    expect(await p2.getSigningKey(rot.newKeyId)).not.toBeNull()
  })
})
