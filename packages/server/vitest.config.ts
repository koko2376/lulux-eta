import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    isolate: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
