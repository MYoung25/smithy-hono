/**
 * Run the `@smithy-hono/data-core` DataStore conformance suite against the
 * Cloudflare adapter's two backends wired to in-process FAKE ports. The fakes
 * honor the same atomicity / consistency contracts as the real backends, so the
 * optimistic-concurrency, scope-isolation, and pagination assertions exercise
 * the real store logic. The live SQL / KV is validated by
 * `live.miniflare.dataStore.test.ts`.
 *
 *   - **D1** — the primary, full-featured store: full optimistic concurrency
 *     (SQL CAS), equality filter + count (`WHERE`), opaque-cursor pagination,
 *     and soft-delete. Asserted with declared `indexes` so the filter test hits
 *     an indexed path; hard-delete + soft-delete variants like adapter-node.
 *   - **KV** — the key-access SUBSET: declares `{ optimisticConcurrency: false,
 *     filter: false }` (KV has no atomic CAS and can't equality-filter opaque
 *     values); pagination (native prefix `list()` cursor) and soft-delete pass.
 */

import { describe, it, expect } from 'vitest'
import { describeDataStore } from '@smithy-hono/data-core/conformance'
import {
  createD1DataStore,
  createFakeD1DataPort,
  createKvDataStore,
} from './dataStore.js'
import { FakeKvNamespace } from './test-support.js'

// --- D1: hard-delete (default) — all caps except softDelete. ----------------
describeDataStore(
  () => createD1DataStore(createFakeD1DataPort(), { indexes: ['kind'] }),
  { optimisticConcurrency: true, pagination: true, filter: true, softDelete: false },
)

// --- D1: soft-delete — same, plus tombstone invisibility. -------------------
describeDataStore(
  () => createD1DataStore(createFakeD1DataPort(), { indexes: ['kind'], softDelete: true }),
  { optimisticConcurrency: true, pagination: true, filter: true, softDelete: true },
)

// --- KV: key-access subset — no optimistic concurrency, no filter. ----------
describeDataStore(
  () => createKvDataStore(new FakeKvNamespace()),
  { optimisticConcurrency: false, pagination: true, filter: false, softDelete: false },
)

// --- KV: soft-delete variant (still no CAS / filter). -----------------------
describeDataStore(
  () => createKvDataStore(new FakeKvNamespace(), { softDelete: true }),
  { optimisticConcurrency: false, pagination: true, filter: false, softDelete: true },
)

// --- KV fail-fast: optimisticConcurrency MUST throw at construction. ---------
describe('createKvDataStore — fail fast on optimisticConcurrency', () => {
  it('throws at construction when optimisticConcurrency is requested', () => {
    expect(() =>
      createKvDataStore(new FakeKvNamespace(), { optimisticConcurrency: true }),
    ).toThrow(/optimisticConcurrency is not supported on Workers KV/)
  })
})
