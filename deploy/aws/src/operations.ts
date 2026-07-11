/**
 * A minimal operation registry for the sample handler.
 *
 * In a real service this is the codegen-emitted `OPERATIONS` map
 * (`generated/registry.gen.ts`); here we hand-write one entry so the sample
 * stands alone. Its shape is the structural `OperationRegistry` the pipeline
 * reads (security-core/src/pipeline/index.ts) — the generated map is assignable
 * to it, so swapping in the real registry is a one-line import change.
 *
 * The single `CreateOrder` op uses `sigv4Hmac` (S2S HMAC) auth and is NOT
 * `readonly`, so the pipeline (a) requires `stores.secrets` + `stores.nonce`
 * (validateConfig enforces this), and (b) runs the S6 `verifySignature` phase —
 * which calls `readRawBody(c)` to re-derive the HMAC body hash from the bytes the
 * client signed. That is the raw-body + HMAC path this deployable exists to prove
 * works under `hono/aws-lambda`.
 */

import type { OperationRegistry } from '@smithy-hono/security-core'

export const OPERATIONS: OperationRegistry = {
  CreateOrder: {
    name: 'CreateOrder',
    method: 'POST',
    path: '/orders',
    authSchemes: [{ type: 'sigv4Hmac' }],
    readonly: false, // ⇒ nonce-tracked by default (replay protection, SIGN-03).
    requiredPermissions: [],
    cost: 1,
    constraints: { maxBodyBytes: 1_048_576, hasConstrainedInput: false },
  },
}
