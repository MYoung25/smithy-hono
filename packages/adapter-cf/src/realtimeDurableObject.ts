/**
 * The realtime PUSH backend for the `@smithy-hono/realtime` `RealtimeHub` port,
 * on Cloudflare (Phase L4). Two pieces:
 *
 *   1. {@link RealtimeDurableObject} — a STOCK, GENERIC, STATELESS Durable Object
 *      that fans a notified event out to every live subscriber of the one channel
 *      it represents. It is keyed `idFromName(channelId)` (one object per
 *      `` `${resource}:${id}` ``), holds NO `ctx.storage` and NO alarm (idle
 *      channels cost nothing), and generalizes parks' per-game `GameRoom` relay
 *      to an opaque channel id. ONE stock class serves every `@live` resource —
 *      the codegen emits no per-resource DO class.
 *
 *   2. {@link createDurableObjectHub} — the namespace-side `RealtimeHub`: `notify`
 *      `fetch`es the channel's DO `/notify` (best-effort, never throws) and
 *      `subscribe` bridges the DO's SSE stream back into the in-isolate
 *      `onEvent` callback the generated endpoint drives. {@link forwardLiveSubscribe}
 *      is the more efficient direct-forward alternative (the DO owns the client
 *      connection, parks-style) for a router that prefers it — see the wiring
 *      note on {@link createDurableObjectHub}.
 *
 * This mirrors the `SecurityDurableObject` discipline in `durableObject.ts`:
 * fetch-path dispatch over a shared {@link REALTIME_DO_PATHS} contract, narrow
 * `*Like` structural ports (no `@cloudflare/workers-types`), and web-standard
 * primitives only (`Request`/`Response`/`ReadableStream`/`TextEncoder`).
 */

import type { DurableObjectNamespaceLike } from './securityStores.js'
import type { HibernationStateLike } from './ports.js'

// ---------------------------------------------------------------------------
// The `RealtimeHub` port (the FROZEN contract this backend satisfies).
//
// Now consumed directly from the runtime package that OWNS it —
// `@smithy-hono/realtime` (Phase L0) — rather than the structural copies this
// file carried during parallel dev. `RealtimeDurableObject` + the namespace-side
// hub are validated against L0's shared conformance suite (see
// `realtimeDurableObject.conformance.test.ts`). Re-exported so existing local
// imports (`from './realtimeDurableObject.js'`) keep resolving unchanged.
// ---------------------------------------------------------------------------

import type { RealtimeEvent, RealtimeHub } from '@smithy-hono/realtime'

export type { RealtimeEvent, RealtimeHub }

// ---------------------------------------------------------------------------
// The Worker ↔ DO HTTP contract (shared by both ends, like DO_PATHS).
// ---------------------------------------------------------------------------

/**
 * The request/response contract between the namespace-side hub
 * ({@link createDurableObjectHub}) and {@link RealtimeDurableObject}:
 *
 *   POST /notify      body = JSON.stringify(RealtimeEvent)  -> 204 No Content
 *   GET  /subscribe   (SSE)                                 -> 200 text/event-stream
 *   GET  /subscribe   Upgrade: websocket (optional)         -> 101 + client socket
 */
export const REALTIME_DO_PATHS = {
  notify: '/notify',
  subscribe: '/subscribe',
} as const

/**
 * Base URL for a DO stub `fetch`. The stub ignores the host and routes to its
 * object; a well-formed absolute URL is only needed to construct `Request`.
 * (Mirrors `DO_ORIGIN` in `realPorts.ts`.)
 */
const HUB_ORIGIN = 'https://realtime-hub.internal'

/** SSE frame terminator. */
const FRAME_SEP = '\n\n'

/**
 * Server-side heartbeat interval (ms) for the DO's OWN SSE stream (the DO→Worker
 * leg). The client-facing leg (`@smithy-hono/realtime` `liveEventStream`) already
 * heartbeats every 20s; without a matching heartbeat here an idle DO→Worker leg
 * can be silently idle-dropped by an intermediary while the client leg keeps
 * heartbeating, so the client never notices and events are dropped indefinitely.
 * Kept at 20s (≤ typical proxy idle timeouts) so the leg stays observable/alive.
 * Exported so tests can drive it deterministically.
 */
export const SSE_HEARTBEAT_MS = 20_000

/**
 * Per-subscriber in-isolate buffer bound (bytes) for an SSE subscriber. Because
 * `controller.enqueue` only throws on a CLOSED/errored stream, a half-open client
 * that stops reading (but never closes) is never evicted and its unread frames
 * accumulate in isolate memory without bound. Once a subscriber's buffered bytes
 * exceed this bound (`desiredSize` goes negative under the byte-length queuing
 * strategy) the wedged consumer is evicted (closed + dropped). Safe: clients
 * reconcile via the `version` cursor, so a dropped slow consumer just reconnects
 * and refetches. Exported so tests can size payloads against it.
 */
export const SSE_MAX_BUFFERED_BYTES = 1024 * 1024

/**
 * Backoff (ms) before the SSE bridge ({@link pumpSse}) re-subscribes after an
 * UNEXPECTED DO-stream end. Prevents a tight reconnect loop while still healing a
 * dropped DO→Worker leg promptly.
 */
export const SSE_RESUBSCRIBE_DELAY_MS = 250

// ---------------------------------------------------------------------------
// The deployable Durable Object — stateless per-channel fan-out relay.
// ---------------------------------------------------------------------------

/**
 * The minimal `DurableObjectState`-like shape the DO entrypoint may receive. The
 * SSE (MVP) path uses none of it; the optional WebSocket path uses the
 * {@link HibernationStateLike} slice. Cloudflare constructs the DO as
 * `new RealtimeDurableObject(ctx, env)` — both args are accepted and optional so
 * the class is trivially unit-constructable with no platform state.
 */
export type RealtimeDurableObjectStateLike = Partial<HibernationStateLike>

/**
 * A stock, generic, STATELESS fan-out Durable Object. One instance ==> one
 * channel (`idFromName(channelId)`). It tracks the live subscriber set for its
 * channel and, on `/notify`, pushes the event to every subscriber. It persists
 * nothing: `DataStore`/D1 remains the source of truth and the client reconciles
 * via the `version` cursor, so a dropped push, a DO restart, or a hibernation
 * wake never loses events (the push is an optimisation over polling).
 *
 * Register in `wrangler.toml` (one binding per `@live` resource, all pointing at
 * this same class — the deploy derivation in Phase L5 emits these):
 *   [[durable_objects.bindings]]
 *   name = "<RESOURCE>_LIVE"
 *   class_name = "RealtimeDurableObject"
 *   # migration is `new_classes` (NOT `new_sqlite_classes`) — the hub is stateless.
 */
/**
 * One live SSE subscriber: its stream controller plus the handle for the
 * per-subscriber server-side heartbeat, so both are torn down together on
 * cancel/eviction (a leaked interval would keep enqueuing onto a closed stream).
 */
interface SseSubscriber {
  readonly controller: ReadableStreamDefaultController<Uint8Array>
  readonly heartbeat: ReturnType<typeof setInterval>
}

export class RealtimeDurableObject {
  /**
   * Live SSE subscribers for this channel.
   *
   * NOTE (hibernation): this in-isolate Set does NOT survive hibernation. It is
   * only ever populated in a MIXED WS+SSE object, and an open SSE `Response` keeps
   * the isolate pinned alive for as long as any SSE subscriber exists — so the
   * runtime cannot evict the isolate out from under a live entry. The set is thus
   * practically never observed empty-after-wake; the WS path (which DOES survive
   * hibernation via `getWebSockets()`) is the only subscriber surface that spans
   * an eviction. This is a note, not a behavior change.
   */
  private readonly sse = new Set<SseSubscriber>()
  private readonly encoder = new TextEncoder()
  /** The hibernating-WebSocket subscriber surface, iff the runtime provided it. */
  private readonly hibernation: HibernationStateLike | undefined

  constructor(ctx?: RealtimeDurableObjectStateLike, _env?: unknown) {
    this.hibernation =
      ctx && typeof ctx.acceptWebSocket === 'function' && typeof ctx.getWebSockets === 'function'
        ? (ctx as HibernationStateLike)
        : undefined
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // Server -> DO push. Fan the JSON event out to every subscriber, ack 204.
    if (url.pathname === REALTIME_DO_PATHS.notify && request.method === 'POST') {
      const payload = await request.text()
      this.fanOut(payload)
      return new Response(null, { status: 204 })
    }

    // Subscriber attach.
    if (url.pathname === REALTIME_DO_PATHS.subscribe) {
      // Optional WS-hibernation path (parks-style) when the client upgrades and
      // the runtime supports hibernation. Falls through to SSE otherwise.
      if (
        request.headers.get('Upgrade')?.toLowerCase() === 'websocket' &&
        this.hibernation
      ) {
        return this.acceptWebSocket()
      }
      return this.openSse()
    }

    return new Response('Not Found', { status: 404 })
  }

  /** Open an SSE stream, register its subscriber, emit an open comment. */
  private openSse(): Response {
    // Definitely assigned inside `start` (which runs synchronously here) before
    // any deferred `cancel`/heartbeat closure can observe it.
    let sub: SseSubscriber
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          // Periodic server-side heartbeat: a `: heartbeat` comment keeps this
          // DO→Worker leg observable and stops intermediaries from idle-dropping
          // it during quiet periods (mirrors the client leg's own heartbeat).
          // Cleared on cancel/eviction; self-heals if it ever fires post-close.
          const heartbeat = setInterval(() => {
            try {
              controller.enqueue(this.encoder.encode(': heartbeat' + FRAME_SEP))
            } catch {
              // Stream closed out from under the interval — stop + drop.
              this.dropSubscriber(sub)
            }
          }, SSE_HEARTBEAT_MS)
          sub = { controller, heartbeat }
          this.sse.add(sub)
          // A leading comment opens the stream immediately (flushes headers) and
          // doubles as a keep-alive; it carries no `data:` so bridges ignore it.
          controller.enqueue(this.encoder.encode(': connected' + FRAME_SEP))
        },
        // Client/Worker aborted the connection — drop it from the fan-out set.
        cancel: () => {
          this.dropSubscriber(sub)
        },
      },
      // Bound in-isolate buffering by BYTES so a wedged (non-reading) consumer's
      // `desiredSize` goes negative once it exceeds the bound — see fanOut, which
      // evicts past that instead of buffering unboundedly.
      new ByteLengthQueuingStrategy({ highWaterMark: SSE_MAX_BUFFERED_BYTES }),
    )
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      },
    })
  }

  /** Tear down a subscriber's heartbeat and remove it from the fan-out set. */
  private dropSubscriber(sub: SseSubscriber): void {
    clearInterval(sub.heartbeat)
    this.sse.delete(sub)
  }

  /**
   * Evict a wedged subscriber: drop it AND close its stream so the in-isolate
   * buffer is released. The consumer reconnects and refetches via `version`.
   */
  private evictWedged(sub: SseSubscriber): void {
    this.dropSubscriber(sub)
    try {
      sub.controller.close()
    } catch {
      /* already closed/errored */
    }
  }

  /** Accept a hibernatable server WebSocket subscriber (optional path). */
  private acceptWebSocket(): Response {
    const pair = new (globalThis as unknown as {
      WebSocketPair: new () => Record<string, WebSocket>
    }).WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    // The runtime may evict this isolate while the socket sleeps and rehydrate it
    // on the next message/notify. getWebSockets() survives the wake, so the set is
    // durable across hibernation without us holding any state.
    this.hibernation!.acceptWebSocket(server)
    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: WebSocket })
  }

  /** Push one already-serialized event to every live subscriber (best-effort). */
  private fanOut(payload: string): void {
    const frame = this.encoder.encode('data: ' + payload + FRAME_SEP)
    for (const sub of this.sse) {
      try {
        sub.controller.enqueue(frame)
        // Backpressure guard: `desiredSize` = highWaterMark - buffered bytes. A
        // subscriber that has stopped reading accumulates unread frames; once
        // buffered exceeds SSE_MAX_BUFFERED_BYTES desiredSize goes negative — evict
        // the wedged consumer rather than grow isolate memory unboundedly. `null`
        // means the stream is already closed/errored, so drop it too.
        const desired = sub.controller.desiredSize
        if (desired === null || desired < 0) {
          this.evictWedged(sub)
        }
      } catch {
        // Stream already closed/closing — the cancel() handler may lag a beat.
        this.dropSubscriber(sub)
      }
    }
    // Optional WS subscribers (get the raw JSON, no SSE framing).
    for (const ws of this.hibernation?.getWebSockets() ?? []) {
      try {
        ws.send(payload)
      } catch {
        /* socket already closing/closed */
      }
    }
  }

  /** Hibernation liveness heartbeat (no state to mutate). */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (message === 'ping') {
      try {
        ws.send('pong')
      } catch {
        /* closing */
      }
    }
  }

  webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): void {
    try {
      // 1006 (abnormal closure) is reserved and close() rejects it; remap to a
      // clean 1000 so teardown never throws.
      ws.close(code === 1006 ? 1000 : code)
    } catch {
      /* already closed */
    }
  }

  webSocketError(_ws: WebSocket, _error: unknown): void {
    /* nothing to clean up — the socket drops itself */
  }
}

// ---------------------------------------------------------------------------
// The namespace-side RealtimeHub (server isolate -> DO).
// ---------------------------------------------------------------------------

/**
 * Build a {@link RealtimeHub} backed by a Durable Object namespace binding. Each
 * `channelId` maps to one DO via `idFromName(channelId)` (the pinned
 * `` `${resource}:${id}` `` key convention — treated as opaque).
 *
 * WIRING (so L0's `liveEventStream` + the L1 generated router reconcile to it):
 *
 *   - `notify(channelId, event)` POSTs `JSON.stringify(event)` to the channel
 *     DO's {@link REALTIME_DO_PATHS.notify}. It is the publish side that
 *     `withLiveNotify` calls post-commit. Best-effort: any error is swallowed so a
 *     failed notify never fails the write (the client's poll/refetch self-heals).
 *
 *   - `subscribe(channelId, onEvent)` is the PORT-UNIFORM subscribe: it opens an
 *     internal SSE stream to the channel DO's {@link REALTIME_DO_PATHS.subscribe},
 *     decodes each `data:` frame back into a {@link RealtimeEvent}, and invokes
 *     `onEvent` in the Worker isolate. This lets the generated endpoint drive the
 *     transport identically for the polling and DO backends (it `streamSSE`s and
 *     bridges `hub.subscribe` -> `stream.writeSSE`). The returned fn aborts the
 *     internal stream and detaches. NOTE: this double-streams (client <- Worker
 *     <- DO).
 *
 *   - {@link forwardLiveSubscribe} is the ALTERNATIVE, more efficient wiring
 *     (parks-style): the Hono route forwards the client's request straight to the
 *     channel DO and returns the DO's streaming `Response`, so the DO owns the
 *     client connection with no double-stream. A router that takes this path does
 *     NOT use `hub.subscribe`; it still uses `hub.notify` for publish. L1 picks
 *     one; both share the same DO and `/notify` contract.
 */
export function createDurableObjectHub(ns: DurableObjectNamespaceLike): RealtimeHub {
  const stubFor = (channelId: string) => ns.get(ns.idFromName(channelId))

  return {
    async notify(channelId, event): Promise<void> {
      try {
        await stubFor(channelId).fetch(
          new Request(HUB_ORIGIN + REALTIME_DO_PATHS.notify, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(event),
          }),
        )
      } catch {
        // Best-effort by contract — a dropped notify is recovered by the client's
        // version-guarded refetch, so publishing never throws.
      }
    },

    subscribe(channelId, onEvent): () => void {
      const abort = new AbortController()
      void pumpSse(stubFor(channelId), abort.signal, onEvent)
      return () => abort.abort()
    },
  }
}

/**
 * Direct-forward subscribe primitive (the efficient, parks-style wiring). Forward
 * the client's subscribe `request` straight to the channel DO and return the DO's
 * streaming `Response` (SSE, or a 101 WebSocket upgrade if the client upgraded and
 * the DO's runtime supports hibernation). The DO owns the client connection — no
 * double-streaming through the Worker. The L1 router returns this `Response`
 * directly from the mounted `GET /<resource>/:id/events` route.
 *
 * Auth/authz MUST run in the route BEFORE calling this (§4 of the design):
 * an unauthorized caller must never reach the DO. `channelId` is treated as
 * OPAQUE and used verbatim for `idFromName` — the caller (the generated router)
 * owns the cross-tenant guarantee by only ever passing an authorized channelId.
 * The header narrowing below is defense-in-depth, not the auth boundary.
 */
export function forwardLiveSubscribe(
  ns: DurableObjectNamespaceLike,
  channelId: string,
  request: Request,
): Promise<Response> {
  // Defense-in-depth: forward ONLY the headers the DO actually needs to pick a
  // transport (SSE vs. the WebSocket upgrade handshake). Client credentials
  // (cookie/authorization) are NOT forwarded over this internal hop — authz has
  // already run in the route, so the DO never needs them, and dropping them keeps
  // ambient client secrets out of the DO leg.
  const forwarded = new Request(HUB_ORIGIN + REALTIME_DO_PATHS.subscribe, {
    method: request.method,
    headers: narrowSubscribeHeaders(request.headers),
    // Forward the client abort signal so the Worker proactively aborts the DO
    // fetch when the client disconnects (no orphaned DO-side subscriber).
    signal: request.signal,
  })
  return ns.get(ns.idFromName(channelId)).fetch(forwarded)
}

/**
 * The allowlist of client headers forwarded to the DO on the internal subscribe
 * hop: just enough to preserve a WebSocket upgrade (parks-style) and content
 * negotiation. Everything else — notably `cookie`/`authorization` — is dropped.
 */
const FORWARDED_SUBSCRIBE_HEADERS = [
  'upgrade',
  'connection',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-protocol',
  'sec-websocket-extensions',
  'accept',
] as const

function narrowSubscribeHeaders(source: Headers): Headers {
  const headers = new Headers()
  for (const name of FORWARDED_SUBSCRIBE_HEADERS) {
    const value = source.get(name)
    if (value !== null) headers.set(name, value)
  }
  return headers
}

/**
 * Bridge the DO's SSE stream into `onEvent` with RECONNECT resilience (R3-2).
 *
 * A single {@link pumpSseOnce} pass ends when the DO stream ends OR the caller
 * aborts. If it ends WITHOUT an intentional unsubscribe (the abort `signal` is
 * still live) the DO→Worker leg died unexpectedly — DO eviction/restart, an idle
 * proxy drop, etc. The client-facing leg keeps heartbeating and would otherwise
 * look healthy forever over a dead DO leg, silently dropping every event.
 *
 * The frozen `RealtimeHub.subscribe` port hands us only an `onEvent` callback —
 * there is no closure channel to end the client SSE leg from here — so the
 * simplest correct fix is to RE-SUBSCRIBE to the DO (after a short backoff) until
 * the caller intentionally unsubscribes. Redelivery is safe because clients
 * reconcile via the `version` cursor. The loop is bounded by client presence: the
 * client's disconnect aborts `signal` (via the endpoint's `unsubscribe`), which
 * stops it. An intentional unsubscribe therefore tears down cleanly with no
 * reconnect.
 */
async function pumpSse(
  stub: { fetch(request: Request): Promise<Response> },
  signal: AbortSignal,
  onEvent: (event: RealtimeEvent) => void,
): Promise<void> {
  while (!signal.aborted) {
    await pumpSseOnce(stub, signal, onEvent)
    if (signal.aborted) return
    // Unexpected DO-stream end — back off, then re-subscribe.
    await sleep(SSE_RESUBSCRIBE_DELAY_MS, signal)
  }
}

/** Resolve after `ms`, or immediately when `signal` aborts (whichever first). */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * ONE subscribe pass: read the DO's SSE stream to end-of-stream/abort, decoding
 * each `data:` frame into a {@link RealtimeEvent} and handing it to `onEvent`.
 * Comment frames (`:`-lead keep-alives / heartbeats, no `data:`) are ignored.
 * Never throws — a stream/abort error simply ends the pass.
 */
async function pumpSseOnce(
  stub: { fetch(request: Request): Promise<Response> },
  signal: AbortSignal,
  onEvent: (event: RealtimeEvent) => void,
): Promise<void> {
  try {
    const res = await stub.fetch(
      new Request(HUB_ORIGIN + REALTIME_DO_PATHS.subscribe, { method: 'GET', signal }),
    )
    if (!res.ok || !res.body) return
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf(FRAME_SEP)) !== -1) {
        const frame = buffer.slice(0, idx)
        buffer = buffer.slice(idx + FRAME_SEP.length)
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice('data:'.length).replace(/^ /, ''))
          .join('\n')
        if (data === '') continue // comment / keep-alive frame
        try {
          onEvent(JSON.parse(data) as RealtimeEvent)
        } catch {
          /* malformed frame — skip, do not tear down the subscription */
        }
      }
    }
  } catch {
    /* aborted or stream error — pump ends, which is the unsubscribe outcome */
  }
}
