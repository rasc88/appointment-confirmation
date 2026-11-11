import { expect, test } from '@playwright/test';
import { createAppointment, dashboardRow, hourMs, openDashboardOn, signIn, uniqueName } from '../helpers.js';

test('§16.2–16.5 create, copy, no reply yet, client confirms, dashboard updates without a reload', async ({ page, browser }) => {
  const service = uniqueName('Create');
  const startsAt = new Date(Date.now() + 3 * hourMs);
  await signIn(page);
  const link = await createAppointment(page, { newClientName: uniqueName('Client') }, service, () => startsAt);
  expect(link.startsWith('http://localhost:8085/c/')).toBe(true);
  await page.getByRole('button', { name: 'Copy link' }).click();
  await expect(page.getByText('Link copied.')).toBeVisible();

  await openDashboardOn(page, startsAt);
  await expect(dashboardRow(page, 'At risk', service)).toContainText('No reply yet');

  const clientContext = await browser.newContext();
  const clientPage = await clientContext.newPage();
  await clientPage.goto(link);
  await expect(clientPage.getByText('Please confirm your appointment')).toBeVisible();
  await expect(clientPage.getByText(service)).toBeVisible();
  await clientPage.getByRole('button', { name: 'Confirm appointment' }).click();
  await expect(clientPage.getByText('Your appointment is confirmed')).toBeVisible();
  await clientContext.close();

  await expect(dashboardRow(page, 'Confirmed', service)).toContainText('Confirmed by client', { timeout: 45_000 });
});
