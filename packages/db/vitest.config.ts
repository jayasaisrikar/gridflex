import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Database tests share one connection and use transaction rollback for
    // isolation, so they must not run concurrently against each other.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
