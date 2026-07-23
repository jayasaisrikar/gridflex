import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, test } from './pilot-fixtures';
import {
  LOCAL_PILOT,
  STALE_TELEMETRY_PILOT,
  usesDisposableLocalPilot,
} from './pilot-data';

const destinations = [
  { label: 'Overview', path: '/console', heading: null },
  { label: 'Telemetry', path: '/console/telemetry', heading: 'Telemetry' },
  { label: 'Envelope', path: '/console/envelope', heading: /(?:Flexibility envelope|Envelope)/ },
  { label: 'Drills', path: '/console/drills', heading: 'Drill workbench' },
  { label: 'Passport', path: '/console/passport', heading: 'Flexibility Passport' },
  { label: 'Facility & Safety', path: '/console/facility', heading: 'Facility & safety' },
  { label: 'Connectors', path: '/console/connectors', heading: 'Connectors' },
  { label: 'Audit', path: '/console/audit', heading: 'Audit & activity' },
] as const;

test('desktop rail navigates the complete operator workspace', async ({ page }) => {
  await page.goto('/console');
  const nav = page.getByRole('navigation', { name: 'Console' });
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('link')).toHaveCount(destinations.length);

  for (const destination of destinations.slice(1)) {
    await test.step(destination.label, async () => {
      await nav.getByRole('link', { name: destination.label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${destination.path.replaceAll('/', '\\/')}$`));
      await expect(page.getByRole('heading', { level: 1, name: destination.heading! })).toBeVisible();
      await expect(
        nav.getByRole('link', { name: destination.label, exact: true }),
      ).toHaveAttribute('aria-current', 'page');
    });
  }
});

test('command menu opens from the keyboard and routes the active result', async ({ page }) => {
  await page.goto('/console');
  await page.keyboard.press('ControlOrMeta+k');

  const command = page.getByLabel('Go to a console page');
  await expect(command).toBeFocused();
  await command.fill('quality');
  await expect(page.getByRole('option', { name: /Telemetry/ })).toBeVisible();
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(/\/console\/telemetry$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Telemetry' })).toBeVisible();
});

test('an expired access cookie refreshes without losing the requested route', async ({ page, context }) => {
  await page.goto('/console');
  const before = await context.cookies();
  const access = before.find((cookie) => cookie.name === 'gf_at');
  const refresh = before.find((cookie) => cookie.name === 'gf_rt');
  expect(Boolean(access)).toBe(true);
  expect(Boolean(refresh)).toBe(true);
  expect(access?.httpOnly).toBe(true);
  expect(refresh?.httpOnly).toBe(true);

  await context.clearCookies({ name: 'gf_at' });
  expect((await context.cookies()).some((cookie) => cookie.name === 'gf_at')).toBe(false);
  expect((await context.cookies()).some((cookie) => cookie.name === 'gf_rt')).toBe(true);

  await page.goto('/console/telemetry');
  await expect(page).toHaveURL(/\/console\/telemetry$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Telemetry' })).toBeVisible();

  const recovered = await context.cookies();
  expect(recovered.some((cookie) => cookie.name === 'gf_at' && cookie.httpOnly)).toBe(true);
  expect(recovered.some((cookie) => cookie.name === 'gf_rt' && cookie.httpOnly)).toBe(true);
  expect(await page.evaluate(() => document.cookie)).not.toContain('gf_');
  const body = await page.locator('body').innerText();
  expect(access ? body.includes(access.value) : false, 'the old access token is never rendered').toBe(false);
  expect(refresh ? body.includes(refresh.value) : false, 'the refresh token is never rendered').toBe(false);
});

test('envelope recompute creates a new immutable version', async ({ page }) => {
  await page.goto('/console/envelope');
  const heading = page.getByRole('heading', { level: 1 });

  if (await page.getByRole('button', { name: 'Compute envelope' }).isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Compute envelope' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Flexibility envelope' })).toBeVisible();
    return;
  }

  await expect(heading).toHaveText('Flexibility envelope');
  const versionText = await page.locator('.pagehead__sub').innerText();
  const version = Number(versionText.match(/version\s+(\d+)/i)?.[1]);
  expect(Number.isFinite(version)).toBeTruthy();

  await page.getByRole('button', { name: 'Recompute envelope' }).click();
  await expect
    .poll(async () => {
      const next = await page.locator('.pagehead__sub').innerText();
      return Number(next.match(/version\s+(\d+)/i)?.[1]);
    })
    .toBeGreaterThan(version);
});

test('pilot journey runs from a drill plan to a downloadable Passport export', async ({ page }) => {
  test.setTimeout(120_000);
  const drillName = `Browser pilot ${Date.now()}`;

  await page.goto('/console/drills');
  await page.getByLabel('Plan name').fill(drillName);
  await page.getByRole('button', { name: 'Create drill plan' }).click();

  const record = page.locator('.record-list__item').filter({ hasText: drillName });
  // The durable ledger row is the product outcome. A success notice may be
  // replaced as the server-rendered workbench refreshes.
  await expect(record).toBeVisible({ timeout: 30_000 });
  await record.getByRole('link', { name: 'Open proof chain' }).click();

  await page.getByRole('button', { name: 'Validate safety gates' }).click();
  await expect(page.getByRole('button', { name: 'Review arming effects' })).toBeVisible();

  await page.getByRole('button', { name: 'Review arming effects' }).click();
  const phrase = await page.locator('label[for="confirmation_phrase"] strong').innerText();
  await page.getByLabel(/Type .* to arm/).fill(phrase);
  await page.getByRole('button', { name: 'Arm drill' }).click();

  await expect(page.getByRole('button', { name: 'Start drill' })).toBeVisible();
  await page.getByRole('button', { name: 'Start drill' }).click();
  await expect(page.getByRole('button', { name: 'Complete sustain window' })).toBeVisible();

  await page.getByRole('button', { name: 'Complete sustain window' }).click();
  await expect(page.getByRole('button', { name: 'Verify evidence' })).toBeVisible();
  await page.getByRole('button', { name: 'Verify evidence' }).click();

  await expect(
    page.getByText('Operational state', { exact: true }).locator('..'),
  ).toContainText('COMPLETED');
  await expect(page.getByText('Evidence digest', { exact: true })).toBeVisible();

  await page.goto('/console/passport');
  const issueButton = page.getByRole('button', { name: /Issue (?:Flexibility )?Passport/i });
  await expect(issueButton).toBeVisible();
  await issueButton.click();
  // Issuance replaces the empty/version panel with the durable verified record,
  // so assert the product outcome rather than a transient form-state toast.
  await expect(page.getByText(/Verified · v\d+/)).toBeVisible();
  await expect(page.getByText('Independent verification', { exact: true })).toBeVisible();

  await page.getByLabel('Export format').selectOption('JSON');
  await page.getByLabel('Counterparty').fill('Playwright pilot reviewer');
  await page.getByRole('button', { name: 'Prepare export' }).click();
  const exportStatus = page.getByRole('status').filter({ hasText: /Export ready/i });
  const downloadLink = exportStatus.getByRole('link', { name: /Download JSON/i });
  await expect(downloadLink).toBeVisible();

  const downloadResponse = await page.request.get(await downloadLink.getAttribute('href') ?? '');
  expect(downloadResponse.status()).toBe(200);
  expect(downloadResponse.headers()['content-type']).toContain('application/json');
  expect((await downloadResponse.body()).byteLength).toBeGreaterThan(100);

  await page.getByLabel('Export format').selectOption('PDF');
  await page.getByRole('button', { name: 'Prepare export' }).click();
  const pdfLink = exportStatus.getByRole('link', { name: /Download PDF/i });
  await expect(pdfLink).toBeVisible();

  const pdfResponse = await page.request.get(await pdfLink.getAttribute('href') ?? '');
  expect(pdfResponse.status()).toBe(200);
  expect(pdfResponse.headers()['content-type']).toContain('application/pdf');
  const pdfBytes = await pdfResponse.body();
  expect(pdfBytes.subarray(0, 8).toString('ascii')).toBe('%PDF-1.4');
  const pdfPath = resolve(
    __dirname,
    '../../../output/pdf/gridflex-passport-pilot.pdf',
  );
  await mkdir(dirname(pdfPath), { recursive: true });
  await writeFile(pdfPath, pdfBytes);
});

test('emergency stop preempts a running drill and preserves the abort evidence', async ({
  page,
  context,
}) => {
  test.skip(
    !usesDisposableLocalPilot(),
    'The destructive emergency-stop scenario is restricted to the disposable local pilot.',
  );
  test.setTimeout(120_000);

  const drillName = `Emergency preemption ${Date.now()}`;
  const reasonCode = 'E2E_EMERGENCY_PREEMPTION';
  const reasonDetail = 'Playwright verifies that emergency stop preempts active execution.';
  let stopMayBeActive = false;

  try {
    await page.goto('/console/drills');
    await page.getByLabel('Plan name').fill(drillName);
    await page.getByRole('button', { name: 'Create drill plan' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: /Drill plan created/i }),
    ).toBeVisible();

    const record = page.locator('.record-list__item').filter({ hasText: drillName });
    await record.getByRole('link', { name: 'Open proof chain' }).click();
    await page.getByRole('button', { name: 'Validate safety gates' }).click();
    await page.getByRole('button', { name: 'Review arming effects' }).click();

    const phrase = await page.locator('label[for="confirmation_phrase"] strong').innerText();
    await page.getByLabel(/Type .* to arm/).fill(phrase);
    await page.getByRole('button', { name: 'Arm drill' }).click();
    await page.getByRole('button', { name: 'Start drill' }).click();
    await expect(page.getByRole('button', { name: 'Emergency stop' })).toBeVisible();

    await page.getByLabel('Emergency reason code').fill(reasonCode);
    await page.getByLabel('Situation detail').fill(reasonDetail);
    stopMayBeActive = true;
    await page.getByRole('button', { name: 'Emergency stop' }).click();

    const operationalState = page.getByText('Operational state', { exact: true }).locator('..');
    await expect(operationalState).toContainText('ABORTED');
    await page.reload();
    await expect(
      page.getByText('Operational state', { exact: true }).locator('..'),
    ).toContainText('ABORTED');

    await page.goto('/console/audit');
    const stopEvent = page
      .locator('.audit-entry')
      .filter({ hasText: 'Emergency stop' })
      .filter({ hasText: reasonCode })
      .first();
    await expect(stopEvent).toBeVisible();
    await expect(stopEvent).toContainText('Drill event');
    await stopEvent.locator('summary').click();
    await expect(stopEvent.locator('pre')).toContainText(drillName);
    await expect(stopEvent.locator('pre')).toContainText(reasonDetail);
  } finally {
    if (stopMayBeActive) {
      await clearEmergencyStopLatch(page, context);
    }
  }
});

test('stale telemetry blocks envelope computation with an actionable explanation', async ({
  page,
  context,
}) => {
  test.skip(
    !usesDisposableLocalPilot(),
    'The stale-telemetry fixture exists only in the disposable local pilot database.',
  );

  await context.clearCookies();
  await page.goto('/login');
  await page.getByLabel('Email').fill(STALE_TELEMETRY_PILOT.email);
  await page.getByLabel('Password').fill(STALE_TELEMETRY_PILOT.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/console$/);

  await page.goto('/console/envelope');
  await expect(page.getByRole('heading', { level: 1, name: 'Envelope' })).toBeVisible();
  await expect(page.getByText('No current envelope', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Compute envelope' }).click();

  const alert = page.getByRole('alert').filter({ hasText: 'Telemetry is stale.' });
  await expect(alert).toContainText('Telemetry is stale.');
  await expect(alert).toContainText(
    'Restore a fresh accepted reading before recomputing the envelope.',
  );
  await expect(page.getByText('No current envelope', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Compute envelope' })).toBeEnabled();
});

test('a malformed drill identifier renders the intentional not-found state, never a server error', async ({ page, browserProblems }) => {
  const response = await page.goto('/console/drills/not-a-uuid');
  expect(response?.status() ?? 500).toBeLessThan(500);
  await expect(
    page.getByRole('heading', { level: 1, name: 'This workbench record does not exist' }),
  ).toBeVisible();
  await expect(page.getByText('404', { exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/internal server error|postgres|invalid input syntax/i);

  // A non-streamed response can be HTTP 404, which Chromium reports as a failed
  // resource. A streamed Next notFound boundary can retain HTTP 200; in either
  // case the explicit product state above is the authenticated-route contract.
  for (let index = browserProblems.length - 1; index >= 0; index -= 1) {
    if (/Failed to load resource.*404/i.test(browserProblems[index] ?? '')) {
      browserProblems.splice(index, 1);
    }
  }
});

async function clearEmergencyStopLatch(
  page: import('@playwright/test').Page,
  context: import('@playwright/test').BrowserContext,
) {
  const accessToken = (await context.cookies()).find((cookie) => cookie.name === 'gf_at')?.value;
  expect(accessToken, 'the authenticated operator retains an access token for safety-latch cleanup').toBeTruthy();

  const apiPort = Number(process.env.GRIDFLEX_E2E_API_PORT ?? 4100);
  const response = await page.request.post(
    `http://127.0.0.1:${apiPort}/api/v1/facilities/${LOCAL_PILOT.facilityId}/emergency-stop/clear`,
    {
      headers: { authorization: `Bearer ${accessToken}` },
      data: { clear_note: 'Playwright verified durable abort and emergency-stop evidence.' },
    },
  );
  expect(response.ok(), `emergency-stop latch cleanup returned ${response.status()}`).toBe(true);
}
