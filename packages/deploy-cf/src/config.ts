/**
 * The deploy config a consuming smithy-hono project authors (typically as
 * `smithy-deploy.config.mjs`, which can also be `.json`). It declares exactly
 * what the app needs — entry, UI assets, bindings, secrets, OIDC facts — so the
 * `smithy-hono-deploy` CLI can provision + render + deploy without any
 * app-specific code baked into the tool.
 */

/** A Workers KV namespace the app binds. */
export interface KvBindingSpec {
  /** Binding name the Worker reads (e.g. `SESSIONS`). MUST match the worker `Env`. */
  binding: string
  /**
   * Namespace title to create/reuse in the account. Defaults to
   * `<appName>-<binding>-<domainSlug>` so multiple domains don't collide.
   */
  title?: string
}

/** A Durable Object class the app binds (no pre-deploy provisioning — created by the migration). */
export interface DurableObjectSpec {
  /** Binding name the Worker reads (e.g. `SECURITY_DO`). */
  name: string
  /** The exported DO class name (e.g. `SecurityDurableObject`). */
  className: string
  /** Migration tag registering the class. Default `v1`. */
  migrationTag?: string
}

/**
 * Conventional binding name for the realtime notify-hub Durable Object. The app's
 * composition wiring MUST read this exact name — `createDurableObjectHub(env.REALTIME_HUB)`
 * — so the derived binding and the app agree by construction.
 */
export const REALTIME_HUB_BINDING = 'REALTIME_HUB'

/**
 * The stock, generic realtime hub class exported from `@smithy-hono/adapter-cf`.
 * ONE binding to this single class serves ALL `@live` resources in a service,
 * because the hub is keyed by an opaque `${resource}:${id}` channelId that already
 * namespaces by resource (docs/design/realtime.md §2.B).
 */
export const REALTIME_HUB_CLASS = 'RealtimeDurableObject'

/**
 * Dedicated migration tag for the realtime hub so it registers in its OWN
 * `new_classes` block (Cloudflare migration tags are append-only — the hub must
 * not be folded into an already-applied tag like the security DO's `v1`).
 * `new_classes` (NOT `new_sqlite_classes`) because the hub holds no durable state
 * — it is a stateless fan-out relay (docs/design/realtime.md §3).
 */
export const REALTIME_HUB_MIGRATION_TAG = 'realtime-v1'

/** The single Durable Object spec for the realtime hub (see the constants above). */
export function realtimeHubBinding(): DurableObjectSpec {
  return {
    name: REALTIME_HUB_BINDING,
    className: REALTIME_HUB_CLASS,
    migrationTag: REALTIME_HUB_MIGRATION_TAG,
  }
}

/**
 * Resolve the effective Durable Object bindings for a config: the operator-declared
 * bindings, PLUS — when the service uses `@live` (`realtimeHub: true`) — the single
 * stock {@link realtimeHubBinding}, injected idempotently. A non-realtime config
 * (`realtimeHub` falsy) returns the declared list unchanged → zero churn.
 *
 * Idempotency semantics (R3-5): the dedupe key is the CLASS name, not the binding
 * name. One stock class ({@link REALTIME_HUB_CLASS}) serves every `@live` resource,
 * so a declared DO whose `className` is `RealtimeDurableObject` IS the hub (under
 * any binding name) and suppresses injection — a hand-authored hub is never
 * duplicated. Matching on the binding NAME alone is deliberately NOT treated as
 * "already declared": if an operator declares an UNRELATED DO that merely reuses the
 * reserved `REALTIME_HUB` binding name (a different `className`), we do NOT silently
 * swallow the realtime injection (the old OR-match false-positive). Instead that
 * genuine name collision is surfaced as an error, because rendering two
 * `[[durable_objects.bindings]]` with the same `name` would fail at `wrangler deploy`
 * anyway — better to fail early with an actionable message than deploy-time or,
 * worse, silently drop the realtime backend.
 *
 * R3-6 (deploy cannot verify the worker export): this derivation adds the binding +
 * migration but nothing here checks that `config.workerEntry` actually re-exports
 * `RealtimeDurableObject` (from `@smithy-hono/adapter-cf`). A missing re-export only
 * surfaces at `wrangler deploy`/runtime. There is no export-introspection seam in
 * this tool (KV/D1/DO bindings are likewise not cross-checked against the entry), so
 * this is documented rather than enforced: the app's composition wiring MUST
 * `export { RealtimeDurableObject } from '@smithy-hono/adapter-cf'` from its worker
 * entry for the derived binding to resolve.
 */
export function deriveDurableObjects(config: DeployConfig): DurableObjectSpec[] {
  const declared = config.bindings?.durableObjects ?? []
  if (!config.realtimeHub) return declared

  // Dedupe on the class (the real key): a declared DO of the stock class IS the hub.
  const hubAlreadyDeclared = declared.some((d) => d.className === REALTIME_HUB_CLASS)
  if (hubAlreadyDeclared) return declared

  // Genuine name collision: the reserved binding name is used by an UNRELATED class.
  const nameCollision = declared.find((d) => d.name === REALTIME_HUB_BINDING)
  if (nameCollision) {
    throw new Error(
      `deriveDurableObjects: binding name "${REALTIME_HUB_BINDING}" is reserved for the ` +
        `realtime hub (class "${REALTIME_HUB_CLASS}") but is declared for an unrelated ` +
        `class "${nameCollision.className}". Rename that binding — the realtime hub with ` +
        `realtimeHub:true owns "${REALTIME_HUB_BINDING}".`,
    )
  }

  return [...declared, realtimeHubBinding()]
}

/** A D1 database the app binds. */
export interface D1BindingSpec {
  /** Binding name the Worker reads (e.g. `DB`). */
  binding: string
  /** Database name to create/reuse. */
  databaseName: string
  /** Directory of D1 migrations to apply after create. */
  migrationsDir?: string
}

export interface BindingsSpec {
  kv?: KvBindingSpec[]
  durableObjects?: DurableObjectSpec[]
  d1?: D1BindingSpec[]
}

/**
 * A secret bound via `wrangler secret put`. Either auto-generated (`generate`)
 * or read from the gitignored secrets file (`from: 'secretsFile'`, e.g. an IdP
 * client secret the user supplies).
 *
 * `hmac-hex`    — random bytes, lowercase-hex encoded (what the CF
 *                 `EnvSecretProvider` requires for HMAC key material).
 * `hmac-base64` — random bytes, base64 (e.g. an OIDC state-cookie signing key).
 * `random-base64` — random bytes, base64 (e.g. an audit salt).
 */
export type SecretSpec =
  | { name: string; generate: 'hmac-hex' | 'hmac-base64' | 'random-base64'; bytes?: number }
  | { name: string; from: 'secretsFile' }

export interface AssetsSpec {
  /** Built static-asset directory (relative to the config dir), e.g. `web/dist`. */
  dir: string
  /** Command to build the assets before deploy (run in the config dir). */
  buildCommand?: string
  /** API path prefix served by the Worker (assets serve everything else). Default `/api`. */
  apiPrefix?: string
  /** Serve `index.html` for non-asset, non-API paths (SPA fallback). Default true. */
  spa?: boolean
}

/** Non-secret OIDC facts (from the user's IdP). Secrets go in the secrets file. */
export interface OidcFacts {
  issuer: string
  clientId: string
  authorizeUrl: string
  tokenUrl: string
}

/** Context passed to the `vars` function: the resolved domain + api prefix. */
export interface VarsContext {
  domain: string
  apiPrefix: string
}

export interface DeployConfig {
  /** Worker name (and base for resource titles). */
  appName: string
  /** Worker entry, relative to the config dir (e.g. `src/worker.ts`). */
  workerEntry: string
  /** Workers `compatibility_date`. Default `2024-09-23` (matches the repo's workers). */
  compatibilityDate?: string
  /** Static-asset (UI) serving config. Omit for an API-only Worker. */
  assets?: AssetsSpec
  /** Bindings to provision + render. */
  bindings?: BindingsSpec
  /**
   * Set `true` when the modeled service uses the `@live` realtime trait and is
   * deployed with the Durable-Object push backend. Derives ONE stock realtime hub
   * binding (`REALTIME_HUB` → `RealtimeDurableObject`) plus its `new_classes`
   * migration, so operators don't hand-author them (docs/design/realtime.md §2.D).
   * A single binding serves every `@live` resource — the hub is keyed by an opaque
   * `${resource}:${id}` channelId. Idempotent: an operator-declared hub binding in
   * {@link BindingsSpec.durableObjects} is not duplicated. Leave unset for the
   * polling backend (free-plan / no-DO), which provisions nothing.
   *
   * FUTURE SEAM: once codegen (Phase L1) emits a machine-readable deploy manifest
   * marking `@live` resources, this flag can be auto-derived from that artifact
   * instead of being set by hand.
   */
  realtimeHub?: boolean
  /** Secrets to generate/sync via `wrangler secret put`. */
  secrets?: SecretSpec[]
  /**
   * Extra `[vars]` for the Worker, optionally derived from the domain — e.g.
   * `OIDC_REDIRECT_URI: \`https://${domain}/api/auth/callback\``. Returns a flat
   * string→string map.
   */
  vars?: (ctx: VarsContext) => Record<string, string>
  /** Non-secret OIDC facts surfaced into `[vars]` and the post-deploy report. */
  oidc?: OidcFacts
  /**
   * Path (relative to the config dir) to a gitignored JSON file holding values
   * for `{ from: 'secretsFile' }` secrets, keyed by secret name. Default
   * `deploy.secrets.json`.
   */
  secretsFile?: string
}

/** Identity helper giving editor types + validation when authoring the config. */
export function defineDeployConfig(config: DeployConfig): DeployConfig {
  return config
}

/** Resolve the effective API prefix (default `/api`). */
export function apiPrefixOf(config: DeployConfig): string {
  return config.assets?.apiPrefix ?? '/api'
}
