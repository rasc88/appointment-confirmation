import { expect, test } from '@playwright/test';
import { createAppointment, dashboardRow, hourMs, openDashboardOn, signIn, uniqueName } from '../helpers.js';

test('§16.8 staff confirm and then cancel from the dashboard', async ({ page }) => {
  const service = uniqueName('Staff');
  const startsAt = new Date(Date.now() + 3 * hourMs);
  await signIn(page);
  await createAppointment(page, { newClientName: uniqueName('Client') }, service, () => startsAt);
  await openDashboardOn(page, startsAt);

  await dashboardRow(page, 'At risk', service).getByRole('button', { name: 'Confirm', exact: true }).click();
  const confirmedRow = dashboardRow(page, 'Confirmed', service);
  await expect(confirmedRow).toContainText('Confirmed by staff');

  await confirmedRow.getByRole('button', { name: 'Cancel', exact: true }).click();
  await confirmedRow.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(dashboardRow(page, 'Cancelled', service)).toContainText('Cancelled by staff');
});
