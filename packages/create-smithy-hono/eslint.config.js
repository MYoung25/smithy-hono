/**
 * `create-smithy-hono` is a node-only scaffolding CLI (it reads template files and
 * writes a new project tree), so — unlike the runtime packages — node built-ins are
 * allowed throughout. Test files are ignored.
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
