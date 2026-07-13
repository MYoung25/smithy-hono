/**
 * ARCH-01 import guard.
 *
 * `@smithy-hono/mcp-core` is Web-standard-only — it must never import from
 * `node:*` (or the bare `fs`/`crypto`/`stream`/... node builtins). The bridge
 * runs the same everywhere a Hono service runs (Node, Workers, etc.): it speaks
 * JSON-RPC over Web `Request`/`Response`, converts Zod → JSON Schema, and
 * dispatches in-process via `app.fetch`. No Node-specific transport (e.g. the
 * MCP SDK's node `req`/`res` Streamable-HTTP transport + `fetch-to-node`) is
 * pulled in. This flat ESLint config fails the build (CI: `npm -w
 * @smithy-hono/mcp-core run lint`) if any source file reaches for a node builtin.
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
    // `src/stdio.ts` is the SINGLE deliberately-Node transport (the `./stdio`
    // subpath): a local agent launches it as a subprocess and speaks MCP over
    // stdin/stdout, so it imports `node:process`. The web-standard core (the `.`
    // barrel + every other file) stays guarded — node usage is confined here.
    ignores: ['src/stdio.ts'],
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
                'ARCH-01: mcp-core is Web-standard-only. No node:* imports — the bridge must run on any Web-standard runtime (Node, Workers).',
            },
          ],
          paths: nodeBuiltins.map((name) => ({
            name,
            message:
              'ARCH-01: mcp-core is Web-standard-only. No Node builtin imports.',
          })),
        },
      ],
    },
  },
]
