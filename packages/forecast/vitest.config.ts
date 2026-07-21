import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests need a running local Postgres and are excluded from the
    // default run, so `pnpm test` stays green on a machine without Docker.
    // Run them with `pnpm test:integration` after `pnpm local:db:up`.
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**'],
    environment: 'node',
  },
});
