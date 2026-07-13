/**
 * Layering guard for `@smithy-hono/key-tool` (ARCH-01).
 *
 * The LIBRARY (everything under src/ except src/bin/**) must stay web-standard and
 * portable: no `node:*` imports, no Redis SDK, no adapter import (it drives the
 * structural WritableKeyBackend, never a concrete backend). The CLI under
 * src/bin/** is explicitly node-only and may import `node:*`, `ioredis`, and the
 * node adapter to wire the Redis backend.
 *
 * CI: `npm -w @smithy-hono/key-tool run lint`. Test files are ignored.
 */

import tsParser from '@typescript-eslint/parser'

export default [
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts', 'src/bin/**'],
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
              group: ['node:*'],
              message:
                'ARCH-01: the key-tool LIBRARY stays web-standard — confine node:* to src/bin/** (the CLI).',
            },
            {
              group: ['@smithy-hono/adapter-*'],
              message:
                'The key-tool library drives the structural WritableKeyBackend — adapters are wired only by the CLI (src/bin/**).',
            },
          ],
          paths: [
            {
              name: 'ioredis',
              message: 'ARCH-01: no Redis SDK in the key-tool library — confine to src/bin/** (the CLI).',
            },
          ],
        },
      ],
    },
  },
]
