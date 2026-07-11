/**
 * LIVE conformance — runs the security-core storage conformance suites against
 * the Cloudflare adapter stores wired to a REAL Workers runtime via in-process
 * miniflare: a real Workers KV namespace (sessions) and a real Durable Object
 * (rate-limit + nonce). This validates the actual serial Durable Object dispatch
 * and KV semantics — the strong-consistency guarantees `conformance.test.ts`
 * exercises only through the in-process fake (serial-gate) ports.
 *
 * Gated on `CF_LIVE=1` so the normal suite skips it (no miniflare needed). To run:
 *
 *   npm i -D miniflare        # (or via scripts/verify-live.sh)
 *   CF_LIVE=1 npx vitest run src/live.miniflare.test.ts
 *
 * A tiny worker (bundled at runtime with esbuild) exports a real Durable Object
 * class that delegates to the adapter's SecurityDurableObject logic. Each factory
 * call gets a unique DO id (DO stores) or KV key namespace (sessions) for
 * isolation. miniflare/esbuild/node builtins are imported via non-literal
 * specifiers so this file typechecks WITHOUT those optional deps installed.
 */

import { beforeAll, afterAll, describe, it } from 'vitest'
import {
  describeSessionStore,
  describeRateLimitStore,
  describeNonceStore,
} from '@smithy-hono/security-core/storage/conformance'
import { KvSessionStore } from './sessionStore.js'
import { DurableRateLimitStore } from './rateLimitStore.js'
import { DurableNonceStore } from './nonceStore.js'
import { createFetchRateLimitStub, createFetchNonceStub } from './realPorts.js'
import type { DurableObjectStubLike } from './realPorts.js'
import type { KvNamespaceLike } from './ports.js'

/** Avoid TS resolving these optional/builtin modules at typecheck time. */
const opt = async (spec: string): Promise<Record<string, unknown>> =>
  import(/* @vite-ignore */ spec) as Promise<Record<string, unknown>>

const RUN = process.env.CF_LIVE === '1'

if (!RUN) {
  describe.skip('adapter-cf — live miniflare Durable Objects (set CF_LIVE=1 to run)', () => {
    it('skipped — CF_LIVE not set', () => {})
  })
} else {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mf: any
  let kv: KvNamespaceLike
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let doNs: any
  let n = 0

  /** Namespace a KV so each factory call is isolated within the shared KV. */
  const nsKv = (base: KvNamespaceLike, p: string): KvNamespaceLike => ({
    get: (k) => base.get(p + k),
    put: (k, v, o) => base.put(p + k, v, o),
    delete: (k) => base.delete(p + k),
  })

  /**
   * A fresh DO stub (unique object id) per call → isolated buckets/nonces. The
   * miniflare HOST-side proxy `fetch` wants `(url, init)`, not a `Request` object
   * (a real in-Worker stub accepts a `Request`; the cross-process proxy does not),
   * so we translate the adapter's `Request` into `(url, init)`.
   */
  const stub = (p: string): DurableObjectStubLike => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = doNs.get(doNs.idFromName(`${p}-${++n}`)) as {
      fetch(url: string, init: unknown): Promise<Response>
    }
    return {
      async fetch(request: Request): Promise<Response> {
        const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
        return raw.fetch(request.url, {
          method: request.method,
          headers: Object.fromEntries(request.headers as unknown as Iterable<[string, string]>),
          body: hasBody ? await request.text() : undefined,
        })
      },
    }
  }

  beforeAll(async () => {
    const fs = await opt('node:fs')
    const path = await opt('node:path')
    const esbuild = await opt('esbuild')
    const { Miniflare } = (await opt('miniflare')) as unknown as {
      Miniflare: new (o: unknown) => {
        getKVNamespace(n: string): Promise<unknown>
        getDurableObjectNamespace(n: string): Promise<unknown>
        dispose(): Promise<void>
      }
    }

    const here = (path.dirname as (p: string) => string)(
      new URL(import.meta.url).pathname,
    )

    // Worker entry: a real DO class delegating to the adapter's logic.
    const entry = `
      import { SecurityDurableObject } from './durableObject.js'
      export class SecurityDO {
        #inner
        constructor(ctx) { this.#inner = new SecurityDurableObject({ storage: ctx.storage }) }
        fetch(req) { return this.#inner.fetch(req) }
        // Forward alarm() to the inner DO: the store's active eviction arms
        // setAlarm(), and miniflare/Workers require the REGISTERED class to have an
        // alarm() handler — without this forward, every setAlarm() throws (HTTP 400).
        alarm() { return this.#inner.alarm() }
      }
      export default { async fetch() { return new Response('ok') } }
    `

    // Resolve the adapter's `.js` ESM imports to their `.ts` sources for bundling.
    const tsResolve = {
      name: 'ts-resolve',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setup(build: any) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        build.onResolve({ filter: /\.js$/ }, (args: any) => {
          if (!args.importer) return undefined
          const cand = (path.resolve as (...p: string[]) => string)(
            args.resolveDir,
            args.path.replace(/\.js$/, '.ts'),
          )
          return (fs.existsSync as (p: string) => boolean)(cand) ? { path: cand } : undefined
        })
      },
    }

    const result = (await (
      esbuild.build as (o: unknown) => Promise<{ outputFiles: { text: string }[] }>
    )({
      stdin: { contents: entry, resolveDir: here, loader: 'ts', sourcefile: 'worker.ts' },
      bundle: true,
      format: 'esm',
      write: false,
      platform: 'neutral',
      plugins: [tsResolve],
    }))

    mf = new Miniflare({
      modules: true,
      script: result.outputFiles[0].text,
      durableObjects: { SECURITY_DO: 'SecurityDO' },
      kvNamespaces: ['SESSIONS'],
    })
    kv = (await mf.getKVNamespace('SESSIONS')) as KvNamespaceLike
    doNs = await mf.getDurableObjectNamespace('SECURITY_DO')
  })

  afterAll(async () => {
    if (mf) await mf.dispose()
  })

  describeSessionStore(
    'KvSessionStore (live miniflare KV)',
    () => new KvSessionStore(nsKv(kv, `s${++n}:`)),
  )
  describeRateLimitStore(
    'DurableRateLimitStore (live miniflare DO)',
    () => new DurableRateLimitStore(createFetchRateLimitStub(stub('rl'))),
  )
  describeNonceStore(
    'DurableNonceStore (live miniflare DO)',
    () => new DurableNonceStore(createFetchNonceStub(stub('nonce'))),
  )
}
