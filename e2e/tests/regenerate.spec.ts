import { expect, test } from '@playwright/test';
import { confirmationLinkText, createAppointment, dashboardRow, hourMs, openDashboardOn, signIn, tokenOf, uniqueName } from '../helpers.js';

test('§16.10 regenerating a link invalidates the old one', async ({ page, browser, request }) => {
  const service = uniqueName('Regenerate');
  const startsAt = new Date(Date.now() + 3 * hourMs);
  await signIn(page);
  const oldLink = await createAppointment(page, { newClientName: uniqueName('Client') }, service, () => startsAt);
  await openDashboardOn(page, startsAt);
  await dashboardRow(page, 'At risk', service).getByRole('link', { name: 'Edit' }).click();
  await page.getByRole('button', { name: 'Regenerate link' }).click();
  const newLink = await confirmationLinkText(page);
  expect(newLink).not.toBe(oldLink);

  const clientContext = await browser.newContext();
  const clientPage = await clientContext.newPage();
  await clientPage.goto(oldLink);
  await expect(clientPage.getByText('This link is not valid')).toBeVisible();
  expect((await request.get(`/v1/public/appointments/${tokenOf(oldLink)}`)).status()).toBe(404);
  await clientPage.goto(newLink);
  await expect(clientPage.getByText('Please confirm your appointment')).toBeVisible();
  await clientContext.close();
});
