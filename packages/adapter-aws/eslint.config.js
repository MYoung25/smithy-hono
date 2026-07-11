/**
 * ARCH-01 SDK-import guard.
 *
 * adapter-aws speaks to DynamoDB + Secrets Manager through narrow STRUCTURAL
 * ports (DynamoSendLike, SecretsSourceLike). Runtime source must never import
 * `@aws-sdk/*` — the consumer injects the client. CI:
 * `npm -w @smithy-hono/adapter-aws run lint`.
 *
 * Test files are ignored: live conformance / real-decode tests import the SDK
 * on purpose.
 */

import tsParser from '@typescript-eslint/parser'

export default [
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@aws-sdk/*'],
              message:
                'ARCH-01: adapter-aws uses structural ports (DynamoSendLike, SecretsSourceLike) — no @aws-sdk imports in runtime source; the consumer injects the client.',
            },
          ],
        },
      ],
    },
  },
]
