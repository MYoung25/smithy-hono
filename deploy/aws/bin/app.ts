#!/usr/bin/env node
/**
 * CDK app entrypoint for the smithy-hono AWS security backends (OPS-02).
 *
 * `cdk deploy` synthesizes {@link SecurityBackendStack} — the DynamoDB table,
 * the HMAC signing secret(s), and the sample Lambda + IAM the adapter needs.
 *
 * Config is read from CDK context (`-c key=value` or `cdk.json` → `context`):
 *   - `signingKeyIds`   comma-separated keyIds (newest first). Default `k-demo-1`.
 *   - `secretPrefix`    Secrets Manager name prefix.            Default `prod/sig`.
 *   - `signingClientId` the S2S client whose key is the first.  Default `svc-orders`.
 */

import { App } from 'aws-cdk-lib'
import { SecurityBackendStack } from '../lib/security-backend-stack.js'

const app = new App()

const signingKeyIdsCtx = app.node.tryGetContext('signingKeyIds') as string | undefined
const secretPrefix = app.node.tryGetContext('secretPrefix') as string | undefined
const signingClientId = app.node.tryGetContext('signingClientId') as string | undefined

new SecurityBackendStack(app, 'SmithyHonoSecurityBackend', {
  signingKeyIds: signingKeyIdsCtx ? signingKeyIdsCtx.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  secretPrefix,
  signingClientId,
  // Account/region come from the ambient CDK environment (CDK_DEFAULT_*); set
  // `env` explicitly here if you pin a target account/region.
})
