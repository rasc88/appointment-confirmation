import { expect, test, type Page } from '@playwright/test';
import { createAppointment, dashboardRow, hourMs, openDashboardOn, signIn, uniqueName } from '../helpers.js';

async function setNoReplyWindow(page: Page, hours: string) {
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByLabel('No reply window (hours)').fill(hours);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
}

test('§16.9 the no reply window setting changes which appointments are at risk', async ({ page }) => {
  const service = uniqueName('Settings');
  const startsAt = new Date(Date.now() + 30 * hourMs);
  await signIn(page);
  await createAppointment(page, { newClientName: uniqueName('Client') }, service, () => startsAt);
  try {
    await openDashboardOn(page, startsAt);
    await expect(dashboardRow(page, 'Pending', service)).not.toContainText('No reply yet');

    await setNoReplyWindow(page, '48');
    await openDashboardOn(page, startsAt);
    await expect(dashboardRow(page, 'At risk', service)).toContainText('No reply yet');

    await setNoReplyWindow(page, '24');
    await openDashboardOn(page, startsAt);
    await expect(dashboardRow(page, 'Pending', service)).toBeVisible();
  } finally {
    // Restores the shared settings row even when an assertion above failed.
    await page.request.patch('/v1/settings', { data: { noReplyWindowHours: 24 } });
  }
});
