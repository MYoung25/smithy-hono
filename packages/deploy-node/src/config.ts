/**
 * The deploy config a consuming smithy-hono project authors (typically as
 * `smithy-node-deploy.config.mjs`, which can also be `.json`). It declares exactly
 * what the app needs — container image, optional SPA front-door, namespace,
 * derived env, secrets — so the `smithy-hono-deploy-node` CLI can build + render +
 * apply without any app-specific code baked into the tool.
 *
 * This mirrors `@smithy-hono/deploy-cf`'s config for the Node/Docker/Kubernetes
 * target: instead of provisioning Cloudflare bindings + rendering `wrangler.toml`,
 * it builds container images + renders Kubernetes manifests (Deployment / Service /
 * Ingress / ConfigMap) with an nginx same-origin front door.
 */

/**
 * A secret synced into a per-app Kubernetes `Secret` (consumed by the API
 * Deployment via `envFrom`). Either auto-generated (`generate`) or read from the
 * gitignored secrets file (`from: 'secretsFile'`, e.g. an IdP client secret the
 * user supplies).
 *
 * `hmac-hex`      — random bytes, lowercase-hex encoded (HMAC key material for the
 *                   Node `EnvSecretProvider` which wants hex).
 * `hmac-base64`   — random bytes, base64 (e.g. an OIDC state-cookie signing key).
 * `random-base64` — random bytes, base64 (e.g. an audit salt).
 */
export type SecretSpec =
  | { name: string; generate: 'hmac-hex' | 'hmac-base64' | 'random-base64'; bytes?: number }
  | { name: string; from: 'secretsFile' }

/**
 * Same-origin static web front-door: an nginx container that serves the built SPA
 * and reverse-proxies `apiPrefix/*` to the in-cluster API Service. Because the
 * browser only ever talks to this one origin, the cookie/CSRF model works with no
 * CORS. Omit for an API-only (ClusterIP, no Ingress) deploy.
 */
export interface WebSpec {
  /** Built static-asset directory (relative to the config dir), e.g. `web/dist`. */
  dir: string
  /** Command to build the assets before deploy (run in the config dir via `sh -c`). */
  buildCommand?: string
  /** API path prefix reverse-proxied to the API Service (SPA serves everything else). Default `/api`. */
  apiPrefix?: string
}

/** Context passed to the `env` function: the resolved domain + api prefix. */
export interface EnvContext {
  domain: string
  apiPrefix: string
}

export interface NodeDeployConfig {
  /** App name — base for the Deployment/Service/Secret/ConfigMap object names + image repo. */
  appName: string
  /** API container Dockerfile path (relative to config dir). Default `Dockerfile`. */
  dockerfile?: string
  /**
   * Container image registry base to tag+push, e.g. `registry.example.com/me`. If
   * unset, the image is built locally and NOT pushed (kubectl apply then assumes a
   * locally-available image — e.g. a single-node / kind / minikube cluster).
   */
  registry?: string
  /**
   * Same-origin static web front-door (nginx serving the SPA + proxying
   * `apiPrefix/*` to the API). Omit for an API-only deploy.
   */
  web?: WebSpec
  /** Kubernetes namespace to deploy into. Default `default`. */
  namespace?: string
  /** Container image tag. Default `latest`. */
  imageTag?: string
  /**
   * Extra container env, optionally derived from the domain — e.g.
   * `OIDC_REDIRECT_URI: \`https://${domain}${apiPrefix}/auth/callback\``. Returns a
   * flat string→string map merged over the tool's base env (PORT, and — when a web
   * front-door is present — TRUST_PROXY_HEADERS).
   */
  env?: (ctx: EnvContext) => Record<string, string>
  /** Secrets synced into a k8s Secret from a gitignored file or generated. */
  secrets?: SecretSpec[]
  /**
   * Path (relative to the config dir) to a gitignored JSON file holding values for
   * `{ from: 'secretsFile' }` secrets, keyed by secret name. Default
   * `deploy.secrets.json`.
   */
  secretsFile?: string
}

/** Identity helper giving editor types + validation when authoring the config. */
export function defineNodeDeployConfig(config: NodeDeployConfig): NodeDeployConfig {
  return config
}

/** Resolve the effective API prefix (default `/api`). */
export function apiPrefixOf(config: NodeDeployConfig): string {
  return config.web?.apiPrefix ?? '/api'
}
