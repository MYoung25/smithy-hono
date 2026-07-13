import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Only the scaffolder's own tests — never the files under templates/, which are
    // source for GENERATED projects (they reference each project's src/generated).
    include: ['src/**/*.test.ts'],
  },
})
