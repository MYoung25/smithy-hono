/**
 * `@smithy-hono/deploy-aws` is a node-only deploy tool end to end (it shells out
 * to `cdk` and reads/writes files), so — unlike the runtime packages — node
 * built-ins are allowed throughout. Test files are ignored. The CDK app under
 * `cdk/` is shipped as source and typechecked separately (tsconfig.cdk.json).
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
