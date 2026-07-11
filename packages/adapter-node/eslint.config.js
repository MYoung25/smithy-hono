/**
 * ARCH-01 SDK-import guard.
 *
 * adapter-node talks to Redis through a narrow STRUCTURAL port (RedisClientLike).
 * Runtime source must never import a Redis SDK — the consumer injects the
 * client. CI: `npm -w @smithy-hono/adapter-node run lint`.
 *
 * Test files are ignored: live conformance tests import ioredis on purpose.
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
          paths: [
            {
              name: 'ioredis',
              message:
                'ARCH-01: adapter-node uses a structural RedisClientLike port — no ioredis import in runtime source; the consumer injects the client.',
            },
            {
              name: 'redis',
              message:
                'ARCH-01: adapter-node uses a structural RedisClientLike port — no redis import in runtime source; the consumer injects the client.',
            },
          ],
        },
      ],
    },
  },
]
