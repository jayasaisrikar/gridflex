import { expect, test } from './pilot-fixtures';

const protectedRoutes = [
  '/setup',
  '/console',
  '/console/telemetry',
  '/console/envelope',
  '/console/drills',
  '/console/drills/00000000-0000-0000-0000-000000000000',
  '/console/passport',
  '/console/facility',
  '/console/connectors',
  '/console/audit',
] as const;

test('every console surface redirects an anonymous visitor to sign in', async ({ page }) => {
  for (const route of protectedRoutes) {
    await test.step(route, async () => {
      await page.goto(route);
      await expect(page).toHaveURL(/\/login(?:\?|$)/);
      await expect(
        page.getByRole('heading', { name: /Return to the control room|Sign in/ }),
      ).toBeVisible();
    });
  }
});

test('invalid credentials fail generically without echoing secrets', async ({ page }) => {
  const secret = 'known-wrong-password-value';
  await page.goto('/login');
  await page.getByLabel('Email').fill('unknown-pilot-user@example.invalid');
  await page.getByLabel('Password').fill(secret);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/login\?error=INVALID_CREDENTIALS/);
  await expect(
    page.getByRole('alert').filter({ hasText: 'Email or password is incorrect.' }),
  ).toBeVisible();
  await expect(page.locator('body')).not.toContainText(secret);
});
