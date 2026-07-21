import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    // Transactions are per-connection; parallel files would interleave them.
    fileParallelism: false,
  },
});
