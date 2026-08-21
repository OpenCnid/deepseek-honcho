import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/tests/**/*.spec.ts', 'tests/**/*.spec.ts'],
    coverage: { provider: 'v8', reporter: ['text', 'json-summary'] },
    testTimeout: 10_000,
  },
})
