/**
 * ARCH-01 SDK-import guard.
 *
 * adapter-cf talks to Workers KV + Durable Objects through narrow STRUCTURAL
 * ports (KvNamespaceLike, DurableStorageLike, ...). Runtime source must never
 * import the Cloudflare SDK / miniflare — the consumer supplies the platform
 * objects. CI: `npm -w @smithy-hono/adapter-cf run lint`.
 *
 * Test files are ignored: live conformance tests import miniflare on purpose.
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
              group: ['@cloudflare/*'],
              message:
                'ARCH-01: adapter-cf uses structural platform ports — no Cloudflare SDK imports in runtime source; the consumer injects KV/DO objects.',
            },
          ],
          paths: [
            {
              name: 'miniflare',
              message:
                'ARCH-01: miniflare is a test-only dependency — no import in adapter runtime source.',
            },
            {
              name: 'wrangler',
              message:
                'ARCH-01: no wrangler import in adapter runtime source.',
            },
          ],
        },
      ],
    },
  },
]
