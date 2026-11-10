import type { Appointment, BusinessSettings, Client, StaffMember } from './generated/prisma/client.js';

const placeholderPattern = /\{[^{}]*\}/g;
const allowedPlaceholders = ['{client}', '{business}', '{service}', '{staff}', '{date}', '{time}', '{link}'];
const maxTemplateLength = 500;

export function renderMessage(
  settings: Pick<BusinessSettings, 'messageTemplate' | 'businessName' | 'timeZone'>,
  appointment: Pick<Appointment, 'service' | 'startsAt'> & {
    client: Pick<Client, 'name'>;
    staffMember: Pick<StaffMember, 'name'>;
  },
  link: string,
): string {
  const values: Record<string, string> = {
    '{client}': appointment.client.name,
    '{business}': settings.businessName,
    '{service}': appointment.service,
    '{staff}': appointment.staffMember.name,
    '{date}': new Intl.DateTimeFormat('en-GB', {
      timeZone: settings.timeZone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(appointment.startsAt),
    '{time}': new Intl.DateTimeFormat('en-GB', {
      timeZone: settings.timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(appointment.startsAt),
    '{link}': link,
  };
  return settings.messageTemplate.replace(placeholderPattern, (placeholder) => values[placeholder] ?? placeholder);
}

/** Returns null when valid, otherwise the 422 message for `field: messageTemplate`. */
export function validateMessageTemplate(template: string): string | null {
  const length = [...template].length;
  if (length < 1 || length > maxTemplateLength) {
    return `Must be between 1 and ${maxTemplateLength} characters.`;
  }
  const placeholders: string[] = template.match(placeholderPattern) ?? [];
  const unknownPlaceholder = placeholders.find((placeholder) => !allowedPlaceholders.includes(placeholder));
  if (unknownPlaceholder !== undefined) {
    return `Unknown placeholder ${unknownPlaceholder}. Allowed: ${allowedPlaceholders.join(', ')}.`;
  }
  if (!placeholders.includes('{link}')) {
    return 'Must contain {link}.';
  }
  return null;
}
