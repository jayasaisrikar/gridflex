import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/**
 * NestJS relies on `emitDecoratorMetadata` for constructor injection, and
 * esbuild — which Vitest and tsx use by default — does NOT support it. Without
 * this SWC transform every injected dependency arrives as `undefined` and the
 * whole app fails at runtime with confusing errors rather than at build time.
 *
 * The same constraint applies to `pnpm dev`, which is why it runs compiled
 * output via tsc rather than tsx.
 */
export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
