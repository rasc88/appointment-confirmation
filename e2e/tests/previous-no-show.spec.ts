import { expect, test } from '@playwright/test';
import { createAppointment, dashboardRow, hourMs, openDashboardOn, signIn, uniqueName } from '../helpers.js';

test('§16.6 a client with previous no-shows is at risk', async ({ page }) => {
  const service = uniqueName('No-show');
  const startsAt = new Date(Date.now() + 3 * hourMs);
  await signIn(page);
  await createAppointment(page, { existingClientName: 'Felix Novak' }, service, () => startsAt);
  await openDashboardOn(page, startsAt);
  await expect(dashboardRow(page, 'At risk', service)).toContainText('Missed 2 before');
});
