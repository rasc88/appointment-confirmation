import { expect, type Locator, type Page } from '@playwright/test';

export const hourMs = 3_600_000;

const madridParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function madridWallClock(instant: Date) {
  const parts = Object.fromEntries(madridParts.formatToParts(instant).map(({ type, value }) => [type, value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, dateTime: `${date}T${parts.hour}:${parts.minute}` };
}

export function uniqueName(label: string): string {
  return `E2E ${label} ${Date.now().toString(36)}`;
}

/** Minutes only, as `datetime-local` takes them, so the typed time is the start the app stores. */
export function wholeMinuteFromNow(ms: number): Date {
  return new Date(Math.ceil((Date.now() + ms) / 60_000) * 60_000);
}

export function tokenOf(link: string): string {
  return new URL(link).pathname.split('/').pop()!;
}

export async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('alex@demo.test');
  await page.getByLabel('Password').fill('demo1234');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

type ClientChoice = { newClientName: string } | { existingClientName: string };

async function chooseClient(page: Page, client: ClientChoice) {
  if ('newClientName' in client) {
    await page.getByRole('button', { name: 'New client' }).click();
    await page.getByLabel('Name', { exact: true }).fill(client.newClientName);
    await page.getByRole('button', { name: 'Create client' }).click();
    await expect(page.getByText(`Client: ${client.newClientName}`)).toBeVisible();
    return;
  }
  await page.getByLabel('Search clients').fill(client.existingClientName);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: client.existingClientName }).click();
  await expect(page.getByText(`Client: ${client.existingClientName}`)).toBeVisible();
}

/** `startsAt` is called just before the time is typed, so a start close to now is still in the future on submit. Returns the confirmation link. */
export async function createAppointment(page: Page, client: ClientChoice, service: string, startsAt: () => Date): Promise<string> {
  await page.getByRole('link', { name: 'New appointment' }).click();
  await chooseClient(page, client);
  await page.getByLabel('Service').fill(service);
  await page.getByLabel('Date and time').fill(madridWallClock(startsAt()).dateTime);
  await page.getByRole('button', { name: 'Create appointment' }).click();
  await expect(page.getByRole('heading', { name: 'Appointment created' })).toBeVisible();
  return confirmationLinkText(page);
}

export async function confirmationLinkText(page: Page): Promise<string> {
  const link = page.getByText(/^http:\/\/localhost:8085\/c\//);
  await expect(link).toBeVisible();
  return (await link.textContent())!;
}

export async function openDashboardOn(page: Page, startsAt: Date) {
  await page.getByRole('link', { name: 'Dashboard' }).click();
  await page.getByLabel('Date', { exact: true }).fill(madridWallClock(startsAt).date);
}

/** The row for `service` inside the dashboard group whose summary starts with `group`. */
export function dashboardRow(page: Page, group: string, service: string): Locator {
  return page
    .getByRole('group')
    .filter({ has: page.getByText(new RegExp(`^${group} \\(`)) })
    .getByRole('listitem')
    .filter({ hasText: service });
}
