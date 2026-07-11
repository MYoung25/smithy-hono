/**
 * ARCH-01 SDK-import guard.
 *
 * adapter-postgres talks to Postgres through a narrow STRUCTURAL client port
 * (PgClientLike). Runtime source must never import the `pg` driver (or any other
 * Postgres SDK), and must never reach for `node:*` builtins — the consumer
 * supplies the client object. CI: `npm -w @smithy-hono/adapter-postgres run lint`.
 *
 * Test files are ignored: the live conformance test imports `pg` on purpose
 * (via dynamic import).
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
              group: ['node:*'],
              message:
                'ARCH-01: adapter-postgres runtime source is Web-standard only — no node:* builtins; use crypto.randomUUID / btoa / atob.',
            },
            {
              group: ['postgres', 'postgres/*', '@neondatabase/*'],
              message:
                'ARCH-01: adapter-postgres uses a structural client port (PgClientLike) — no Postgres SDK imports in runtime source; the consumer injects the client.',
            },
          ],
          paths: [
            {
              name: 'pg',
              message:
                'ARCH-01: `pg` is a test-only dependency (the live test dynamic-imports it) — no import in adapter runtime source; the consumer injects a PgClientLike.',
            },
          ],
        },
      ],
    },
  },
]
