/**
 * Request-scoped principal access for the operation implementations.
 *
 * The generated `createNoteRouter` calls `ops.CreateNote(input)` with the
 * VALIDATED input only — it does not (and should not) thread the Hono `Context`
 * into the domain layer. But a few operations need the authenticated identity
 * (e.g. CreateNote stamps `ownerId` from the caller's `principal.id`).
 *
 * We bridge that with `AsyncLocalStorage`: a per-operation middleware in the
 * router's `all` slot (see src/createApp.ts) runs `withPrincipal(...)` so the ops
 * read the caller via {@link currentPrincipal}. This keeps the generated handler
 * signature untouched while giving the domain layer the identity the pipeline
 * already established. (Node-only — `node:async_hooks`.)
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { Principal } from '@smithy-hono/security-core'

const als = new AsyncLocalStorage<Principal>()

/** Run `fn` with `principal` bound as the current request's identity. */
export function withPrincipal<T>(principal: Principal, fn: () => Promise<T>): Promise<T> {
  return als.run(principal, fn)
}

/** The authenticated principal for the in-flight operation, or `undefined`. */
export function currentPrincipal(): Principal | undefined {
  return als.getStore()
}

/** Like {@link currentPrincipal} but throws if absent (the op required auth). */
export function requirePrincipal(): Principal {
  const p = als.getStore()
  if (!p) throw new Error('no principal in scope — operation requires authentication')
  return p
}
