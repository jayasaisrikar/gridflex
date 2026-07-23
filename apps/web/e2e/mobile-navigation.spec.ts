import { expect, expectNoPageOverflow, test } from './pilot-fixtures';

const routes = [
  { label: 'Overview', path: '/console' },
  { label: 'Telemetry', path: '/console/telemetry' },
  { label: 'Envelope', path: '/console/envelope' },
  { label: 'Drills', path: '/console/drills' },
  { label: 'Passport', path: '/console/passport' },
  { label: 'Facility & Safety', path: '/console/facility' },
  { label: 'Connectors', path: '/console/connectors' },
  { label: 'Audit', path: '/console/audit' },
] as const;

test('mobile sheet reaches every console page without overflow or a wrapped app bar', async ({ page }) => {
  await page.goto('/console');

  for (const route of routes) {
    await test.step(route.label, async () => {
      if (!page.url().endsWith(route.path)) await page.goto(route.path);
      await expectNoPageOverflow(page);
      await expectAppBarOnOneLine(page);

      await page.getByRole('button', { name: 'Open navigation' }).click();
      const sheet = page.locator('dialog.mobile-sheet');
      await expect(sheet).toBeVisible();
      const nav = sheet.getByRole('navigation', { name: 'Console' });
      await expect(nav.getByRole('link')).toHaveCount(routes.length);
      for (const destination of routes) {
        await expect(
          nav.getByRole('link', { name: destination.label, exact: true }),
        ).toBeVisible();
      }

      const next = routes[(routes.indexOf(route) + 1) % routes.length]!;
      await nav.getByRole('link', { name: next.label, exact: true }).click();
      await expect(sheet).not.toBeVisible();
      await expect(page).toHaveURL(new RegExp(`${next.path.replaceAll('/', '\\/')}$`));
      await expectNoPageOverflow(page);
    });
  }
});

async function expectAppBarOnOneLine(page: import('@playwright/test').Page) {
  const geometry = await page.locator('.mobilebar').evaluate((bar) => {
    const children = Array.from(bar.children).map((child) => {
      const box = child.getBoundingClientRect();
      return { left: box.left, right: box.right, centerY: box.top + box.height / 2 };
    });
    const box = bar.getBoundingClientRect();
    return { box: { left: box.left, right: box.right, height: box.height }, children };
  });

  expect(geometry.children).toHaveLength(3);
  expect(Math.max(...geometry.children.map((item) => item.centerY)) -
    Math.min(...geometry.children.map((item) => item.centerY))).toBeLessThan(4);
  expect(geometry.box.left).toBeGreaterThanOrEqual(0);
  expect(geometry.box.right).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
  expect(geometry.box.height).toBeLessThanOrEqual(72);
}
