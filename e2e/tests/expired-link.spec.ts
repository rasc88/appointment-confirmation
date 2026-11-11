import { expect, test } from '@playwright/test';
import { createAppointment, signIn, tokenOf, uniqueName, wholeMinuteFromNow } from '../helpers.js';

test('§16.7 a link stops confirming once the appointment has started', async ({ page, browser, request }) => {
  test.setTimeout(240_000);
  let startsAt = new Date();
  await signIn(page);
  const link = await createAppointment(page, { newClientName: uniqueName('Client') }, uniqueName('Expired'), () => {
    startsAt = wholeMinuteFromNow(70_000);
    return startsAt;
  });

  await page.waitForTimeout(startsAt.getTime() + 2_000 - Date.now());

  const clientContext = await browser.newContext();
  const clientPage = await clientContext.newPage();
  await clientPage.goto(link);
  await expect(clientPage.getByText('This appointment has passed')).toBeVisible();
  await expect(clientPage.getByText('This link can no longer confirm or cancel it.')).toBeVisible();
  await expect(clientPage.getByRole('button', { name: 'Confirm appointment' })).toHaveCount(0);
  await expect(clientPage.getByRole('button', { name: 'Cancel appointment' })).toHaveCount(0);
  await clientContext.close();

  const response = await request.post(`/v1/public/appointments/${tokenOf(link)}/confirm`);
  expect(response.status()).toBe(409);
  expect((await response.json()).error.code).toBe('appointment_started');
});
