import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

const APP_ROOT = __dirname;
const WORKSPACE_ROOT = resolve(APP_ROOT, '../..');

const WEB_PORT = Number(process.env.GRIDFLEX_E2E_WEB_PORT ?? 3100);
const API_PORT = Number(process.env.GRIDFLEX_E2E_API_PORT ?? 4100);
// Next production redirects use localhost as their canonical development host.
// Keep the browser origin identical so host-only httpOnly cookies survive the
// redirect and session-recovery path.
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
const DATABASE_URL =
  process.env.GRIDFLEX_E2E_DATABASE_URL ??
  'postgresql://gridflex:gridflex@127.0.0.1:5433/gridflex';
const AUTH_STATE = resolve(WORKSPACE_ROOT, 'output/playwright/.auth/operator.json');

export default defineConfig({
  globalSetup: resolve(APP_ROOT, 'e2e/global-setup.ts'),
  testDir: resolve(APP_ROOT, 'e2e'),
  outputDir: resolve(WORKSPACE_ROOT, 'output/playwright/results'),
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: resolve(WORKSPACE_ROOT, 'output/playwright/report'), open: 'never' }]]
    : [['list'], ['html', { outputFolder: resolve(WORKSPACE_ROOT, 'output/playwright/report'), open: 'never' }]],
  use: {
    baseURL: WEB_ORIGIN,
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  webServer: [
    {
      // Nest relies on tsc-emitted decorator metadata. Build once and run the
      // same dist entrypoint the deployment image uses; file watching can
      // otherwise restart the API between a login and its console redirect.
      command: 'pnpm build:api && pnpm --filter @gridflex/api start',
      cwd: WORKSPACE_ROOT,
      url: `${API_ORIGIN}/api/v1/health/live`,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      env: {
        ...process.env,
        APP_ENV: 'test',
        LOG_LEVEL: 'warn',
        DATABASE_URL,
        API_PORT: String(API_PORT),
        AUTH_SECRET:
          process.env.AUTH_SECRET ??
          'gridflex-e2e-auth-secret-that-is-long-enough-2026',
        CONNECTOR_ENCRYPTION_KEY:
          process.env.CONNECTOR_ENCRYPTION_KEY ??
          'gridflex-e2e-connector-secret-distinct-and-long-2026',
        CORS_ORIGINS: WEB_ORIGIN,
        STORAGE_ROOT: process.env.GRIDFLEX_E2E_STORAGE_ROOT ?? './output/playwright/storage',
      },
    },
    {
      // Production mode exercises the shipped CSP. Next's development runtime
      // intentionally uses eval, which a production-safe policy rejects.
      command: `pnpm --filter @gridflex/web build && pnpm --filter @gridflex/web exec next start -p ${WEB_PORT}`,
      cwd: WORKSPACE_ROOT,
      url: `${WEB_ORIGIN}/login`,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      env: {
        ...process.env,
        API_INTERNAL_BASE_URL: `${API_ORIGIN}/api/v1`,
        NEXT_PUBLIC_API_BASE_URL: `${API_ORIGIN}/api/v1`,
      },
    },
  ],
  projects: [
    {
      name: 'auth-setup',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'unauthenticated',
      testMatch: /auth-protection\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'desktop-chromium',
      testMatch: /desktop-pilot\.spec\.ts/,
      dependencies: ['auth-setup'],
      use: { ...devices['Desktop Chrome'], storageState: AUTH_STATE },
    },
    ...[
      { name: 'mobile-320', width: 320, height: 700 },
      { name: 'mobile-375', width: 375, height: 812 },
      { name: 'mobile-414', width: 414, height: 896 },
      { name: 'responsive-768', width: 768, height: 1024 },
    ].map(({ name, width, height }) => ({
      name,
      testMatch: /mobile-navigation\.spec\.ts/,
      dependencies: ['auth-setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: AUTH_STATE,
        viewport: { width, height },
        isMobile: true,
        hasTouch: true,
      },
    })),
  ],
});
