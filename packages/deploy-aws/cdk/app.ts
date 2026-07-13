#!/usr/bin/env node
/**
 * CDK app entrypoint the `smithy-hono-deploy-aws` CLI drives (via cdk.json's
 * `app: "npx tsx cdk/app.ts"`).
 *
 * The CLI resolves the full config, materializes secrets, and writes a
 * {@link StackInput} JSON to a temp FILE, then passes the file PATH through CDK
 * context (`-c inputFile=<path>`) — NEVER argv — so secret values never leak into
 * a process listing. (An `-c configJson=<inline>` fallback and the
 * `SMITHY_AWS_DEPLOY_INPUT` env var are also honored for non-secret runs.)
 */
import process from 'node:process'
import { readFileSync } from 'node:fs'

import { App } from 'aws-cdk-lib'
import { SmithyHonoAppStack, type StackInput } from './stack.js'

const app = new App()

function loadInput(): StackInput {
  const inline = app.node.tryGetContext('configJson') as string | undefined
  if (inline) return JSON.parse(inline) as StackInput

  const inputFile =
    (app.node.tryGetContext('inputFile') as string | undefined) ??
    process.env.SMITHY_AWS_DEPLOY_INPUT
  if (!inputFile) {
    throw new Error(
      'no stack input provided — pass `-c inputFile=<path>` (or `-c configJson=<json>`, ' +
        'or set SMITHY_AWS_DEPLOY_INPUT). The smithy-hono-deploy-aws CLI sets this for you.',
    )
  }
  return JSON.parse(readFileSync(inputFile, 'utf8')) as StackInput
}

const input = loadInput()

new SmithyHonoAppStack(app, input.appName, {
  input,
  // Region: from the resolved config, else CDK's ambient environment. Account is
  // always taken from the ambient CDK environment (profile / credentials).
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: input.region ?? process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION,
  },
})
