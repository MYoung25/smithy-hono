/**
 * ARCH-01 import guard.
 *
 * `@smithy-hono/security-core` is Web-standard-only — it must never import from
 * `node:*` (or the bare `fs`/`crypto`/`buffer`/... node builtins). Node-specific
 * code lives in the Phase S10 adapter packages, not here. This flat ESLint config
 * fails the build (CI: `npm -w @smithy-hono/security-core run lint`) if any source
 * file reaches for a node builtin.
 */

import tsParser from '@typescript-eslint/parser'

/** Bare (non-prefixed) Node builtins we also want to block. */
const nodeBuiltins = [
  'assert',
  'buffer',
  'child_process',
  'crypto',
  'dns',
  'events',
  'fs',
  'http',
  'https',
  'net',
  'os',
  'path',
  'process',
  'stream',
  'tls',
  'url',
  'util',
  'zlib',
]

export default [
  {
    files: ['src/**/*.ts'],
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
                'ARCH-01: security-core is Web-standard-only. No node:* imports — use crypto.subtle / Web APIs, and put node-specific code in an adapter package.',
            },
          ],
          paths: nodeBuiltins.map((name) => ({
            name,
            message:
              'ARCH-01: security-core is Web-standard-only. No Node builtin imports — put node-specific code in an adapter package.',
          })),
        },
      ],
    },
  },
]
