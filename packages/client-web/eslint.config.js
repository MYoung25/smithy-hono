/**
 * ARCH-01 guard.
 *
 * client-web is a BROWSER package: Web-standard APIs only (fetch / URL /
 * URLSearchParams / History / Location). Runtime source must never import
 * `hono` (it wraps the GENERATED client structurally, not a Hono app) nor any
 * `node:*` builtin. CI: `npm -w @smithy-hono/client-web run lint`.
 *
 * Test files are ignored — they may import the in-process fake backend freely.
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
              name: 'hono',
              message:
                'ARCH-01: client-web wraps the GENERATED client structurally (fetch + headers hooks) — it must not import hono.',
            },
          ],
          patterns: [
            {
              group: ['node:*'],
              message:
                'ARCH-01: client-web is a browser package — no node:* builtins. Use Web-standard APIs only.',
            },
          ],
        },
      ],
    },
  },
]
