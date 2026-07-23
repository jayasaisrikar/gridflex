import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AUTH_STATE, credentials, expect, test } from './pilot-fixtures';

test('operator can sign in and establish an HTTP-only session', async ({ page }) => {
  const { email, password } = credentials();
  await page.goto('/login');

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/console$/);
  await expect(page.getByRole('navigation', { name: 'Console' })).toBeVisible();

  await mkdir(dirname(AUTH_STATE), { recursive: true });
  await page.context().storageState({ path: AUTH_STATE });
});
