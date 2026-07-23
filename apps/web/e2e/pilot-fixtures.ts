import { expect, test as base, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { LOCAL_PILOT } from './pilot-data';

export const AUTH_STATE = resolve(
  __dirname,
  '../../../output/playwright/.auth/operator.json',
);

type PilotFixtures = {
  browserProblems: string[];
};

export const test = base.extend<PilotFixtures>({
  browserProblems: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') {
          problems.push(`console: ${message.text()}`);
        }
      });
      page.on('pageerror', (error) => {
        problems.push(`pageerror: ${error.message}`);
      });

      await use(problems);
      expect(problems, 'the browser emitted no console errors or uncaught exceptions').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';

export function credentials() {
  const email = process.env.GRIDFLEX_E2E_EMAIL ?? LOCAL_PILOT.email;
  const password =
    process.env.GRIDFLEX_E2E_PASSWORD ?? LOCAL_PILOT.password;
  if (!email || !password) {
    throw new Error(
      'Set GRIDFLEX_E2E_EMAIL and GRIDFLEX_E2E_PASSWORD to an operator attached to the seeded pilot facility.',
    );
  }
  return { email, password };
}

export async function expectNoPageOverflow(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      { message: 'the page must not create horizontal document overflow' },
    )
    .toBeLessThanOrEqual(1);
}
