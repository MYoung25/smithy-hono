/**
 * `@smithy-hono/deploy-node` is a node-only deploy tool end to end (it shells out
 * to `docker` / `kubectl` and reads/writes files), so — unlike the runtime
 * packages — node built-ins are allowed throughout. Test files are ignored.
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
    rules: {},
  },
]
