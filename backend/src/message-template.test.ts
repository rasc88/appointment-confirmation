import { describe, expect, it } from 'vitest';
import { renderMessage, validateMessageTemplate } from './message-template.js';

const defaultTemplate =
  'Hi {client}, this is {business}. Please confirm your {service} appointment on {date} at {time}: {link}';
const link = 'https://d111111abcdef8.cloudfront.net/c/3q2-7wFhR0mZx9kLpT4vNw';
const settings = { messageTemplate: defaultTemplate, businessName: 'Demo Studio', timeZone: 'Europe/Madrid' };
const appointment = {
  service: 'Haircut',
  startsAt: new Date('2026-11-11T09:30:00Z'),
  client: { name: 'Maria Lopez' },
  staffMember: { name: 'Alex' },
};

function render(messageTemplate: string, overrides: Partial<typeof appointment> = {}, timeZone = 'Europe/Madrid') {
  return renderMessage({ ...settings, messageTemplate, timeZone }, { ...appointment, ...overrides }, link);
}

function dateAndTime(startsAt: string, timeZone = 'Europe/Madrid') {
  return render('{date} {time}', { startsAt: new Date(startsAt) }, timeZone);
}

describe('renderMessage', () => {
  it('renders the openapi.yaml AppointmentWithLink example message', () => {
    expect(renderMessage(settings, appointment, link)).toBe(
      'Hi Maria Lopez, this is Demo Studio. Please confirm your Haircut appointment on 11/11/2026 at 10:30: https://d111111abcdef8.cloudfront.net/c/3q2-7wFhR0mZx9kLpT4vNw',
    );
  });

  it('replaces each placeholder with its value', () => {
    expect(render('{client}|{business}|{service}|{staff}|{link}')).toBe(
      `Maria Lopez|Demo Studio|Haircut|Alex|${link}`,
    );
  });

  it('replaces every occurrence of a placeholder', () => {
    expect(render('{link} and {link}')).toBe(`${link} and ${link}`);
  });

  it('replaces in a single pass', () => {
    expect(render('Hi {client}: {link}', { client: { name: '{link}' } })).toBe(`Hi {link}: ${link}`);
  });

  it('inserts values literally', () => {
    expect(render('{client}', { client: { name: 'Jo $& Co' } })).toBe('Jo $& Co');
  });

  it('leaves unknown placeholders and lone braces as they are', () => {
    expect(render('{lnik} {Link} { link } {} :-} { {link}')).toBe(`{lnik} {Link} { link } {} :-} { ${link}`);
  });

  it('does not truncate a message longer than 500 characters', () => {
    const longName = 'x'.repeat(600);
    expect(render('{client}', { client: { name: longName } })).toBe(longName);
  });

  it('formats a local date on the next day', () => {
    expect(dateAndTime('2026-11-10T23:30:00Z')).toBe('11/11/2026 00:30');
  });

  it('formats a local date on the previous day', () => {
    expect(dateAndTime('2026-11-11T03:00:00Z', 'America/Los_Angeles')).toBe('10/11/2026 19:00');
  });

  it('formats midnight as 00 in UTC', () => {
    expect(dateAndTime('2026-11-11T00:05:00Z', 'UTC')).toBe('11/11/2026 00:05');
  });

  it('follows the Madrid spring-forward change', () => {
    expect(dateAndTime('2026-03-29T00:30:00Z')).toBe('29/03/2026 01:30');
    expect(dateAndTime('2026-03-29T01:30:00Z')).toBe('29/03/2026 03:30');
  });

  it('shows the repeated hour twice at the Madrid fall-back change', () => {
    expect(dateAndTime('2026-10-25T00:30:00Z')).toBe('25/10/2026 02:30');
    expect(dateAndTime('2026-10-25T01:30:00Z')).toBe('25/10/2026 02:30');
  });
});

describe('validateMessageTemplate', () => {
  const lengthMessage = 'Must be between 1 and 500 characters.';
  const allowed = 'Allowed: {client}, {business}, {service}, {staff}, {date}, {time}, {link}.';

  it('counts length in code points', () => {
    expect(validateMessageTemplate('')).toBe(lengthMessage);
    expect(validateMessageTemplate('{link}' + 'x'.repeat(495))).toBe(lengthMessage);
    expect(validateMessageTemplate('{link}' + 'x'.repeat(494))).toBeNull();
    expect(validateMessageTemplate('{link}' + '😀'.repeat(494))).toBeNull();
  });

  it('accepts 500 emoji, which are 1,000 UTF-16 units, by length', () => {
    const emoji = '😀'.repeat(500);
    expect(emoji).toHaveLength(1000);
    expect(validateMessageTemplate(emoji)).toBe('Must contain {link}.');
  });

  it('checks length before placeholders', () => {
    expect(validateMessageTemplate('{lnik}' + 'x'.repeat(495))).toBe(lengthMessage);
  });

  it.each(['{lnik}', '{Link}', '{ link }', '{}'])('rejects the unknown placeholder %s', (placeholder) => {
    expect(validateMessageTemplate(`Hi ${placeholder} {link}`)).toBe(
      `Unknown placeholder ${placeholder}. ${allowed}`,
    );
  });

  it('names the first unknown placeholder', () => {
    expect(validateMessageTemplate('{link} {first} {second}')).toBe(`Unknown placeholder {first}. ${allowed}`);
  });

  it('requires {link}', () => {
    expect(validateMessageTemplate('Hi {client}')).toBe('Must contain {link}.');
  });

  it('reports an unknown placeholder before a missing {link}', () => {
    expect(validateMessageTemplate('Hi {lnik}')).toBe(`Unknown placeholder {lnik}. ${allowed}`);
  });

  it.each([defaultTemplate, '{link}', '{link} {link}', 'Confirm here: {link}', 'Reply :-} {link}', '{ {link}'])(
    'accepts %s',
    (template) => {
      expect(validateMessageTemplate(template)).toBeNull();
    },
  );
});
