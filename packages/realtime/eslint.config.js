/**
 * ARCH-01 import guard.
 *
 * `@smithy-hono/realtime` is Web-standard-only — it must run identically on Node
 * and on Cloudflare Workers isolates (the whole point of the isolate-safe
 * PollingHub), so it must never import from `node:*` (or the bare
 * `fs`/`crypto`/`buffer`/... node builtins). Timers (`setTimeout`) and streaming
 * come from the global/Web platform and from hono. This flat ESLint config fails
 * the build (CI: `npm -w @smithy-hono/realtime run lint`) if any source file
 * reaches for a node builtin.
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
                'ARCH-01: realtime is Web-standard-only. No node:* imports — use Web/global APIs (setTimeout, streams) and put node-specific code in an adapter package.',
            },
          ],
          paths: nodeBuiltins.map((name) => ({
            name,
            message:
              'ARCH-01: realtime is Web-standard-only. No Node builtin imports — put node-specific code in an adapter package.',
          })),
        },
      ],
    },
  },
]
