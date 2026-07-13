/**
 * ARCH-01 import guard — the test-kit is Web-standard-only so it runs in any test
 * environment (node, workers, jsdom). Node-specific helpers don't belong here.
 */

import tsParser from '@typescript-eslint/parser'

const nodeBuiltins = [
  'assert', 'buffer', 'child_process', 'crypto', 'dns', 'events', 'fs', 'http',
  'https', 'net', 'os', 'path', 'process', 'stream', 'tls', 'url', 'util', 'zlib',
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
                'ARCH-01: test-kit is Web-standard-only. No node:* imports — use Web APIs so tests run in any environment.',
            },
          ],
          paths: nodeBuiltins.map((name) => ({
            name,
            message: 'ARCH-01: test-kit is Web-standard-only. No Node builtin imports.',
          })),
        },
      ],
    },
  },
]
