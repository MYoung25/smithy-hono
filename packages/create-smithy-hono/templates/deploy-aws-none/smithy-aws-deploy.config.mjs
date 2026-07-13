import { defineAwsDeployConfig } from '@smithy-hono/deploy-aws'

/**
 * One-command AWS deploy (CDK): a Lambda API + DynamoDB table, and — full-stack —
 * CloudFront in front of a private S3 SPA origin with `/api/*` routed to the
 * Lambda, same-origin. Run:
 *
 *   npm run deploy -- <your-domain>
 *
 * Prerequisites (the CLI cannot automate these):
 *   - AWS credentials configured (`aws configure` / SSO / env) + `cdk bootstrap`
 *     run once per account/region
 *   - run `npm run codegen` first so `src/generated/` exists (the Lambda bundle
 *     includes it)
 *   - for a custom domain: an ACM certificate in us-east-1 (CloudFront requirement)
 *     and DNS you can point at the CloudFront distribution
 */
export default defineAwsDeployConfig({
  appName: '{{APP_SLUG}}',
  handlerEntry: 'src/handler.ts',
{{ASSETS_CONFIG}}
  tableName: '{{APP_SLUG}}-data',

  // region: 'us-east-1',
  // Custom domain (both required together; cert MUST be in us-east-1):
  // domainName: 'app.example.com',
  // certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/....',
})
