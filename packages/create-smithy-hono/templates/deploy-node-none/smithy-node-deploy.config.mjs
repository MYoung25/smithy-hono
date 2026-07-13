import { defineNodeDeployConfig } from '@smithy-hono/deploy-node'

/**
 * One-command Node/Kubernetes deploy. Builds the API container (and, full-stack,
 * an nginx front-door that serves the SPA and proxies `/api/*` to the API,
 * same-origin), renders the k8s manifests, applies them, and probes
 * `https://<domain>/api/healthz`. Run:
 *
 *   npm run deploy -- <your-domain>
 *
 * Prerequisites (the CLI cannot automate these):
 *   - a working `kubectl` context pointing at your cluster
 *   - an Ingress controller + cert-manager ClusterIssuer (for the TLS host)
 *   - a container registry you can push to (set `registry` below) — or a cluster
 *     that can pull the locally-built image
 *   - run `npm run codegen` first so `src/generated/` exists for the image build
 */
export default defineNodeDeployConfig({
  appName: '{{APP_SLUG}}',
{{ASSETS_CONFIG}}
  namespace: 'default',

  // Image registry to tag + push, e.g. 'registry.example.com/you'. Leave unset to
  // build the image locally only (the cluster must then be able to load/pull it).
  // registry: 'registry.example.com/you',

  env: () => ({
    // Point at an in-cluster Redis for a durable, multi-replica store; without it
    // the API uses an in-memory per-pod store (single-replica / demo). See
    // https://smithy-hono.com for wiring a Redis Deployment/Service.
    // REDIS_URL: 'redis://redis:6379',
    // Honor the front-door's X-Forwarded-Proto (TLS terminates at the Ingress).
    TRUST_PROXY_HEADERS: '1',
  }),
})
