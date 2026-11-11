/** Decision 22: the client page spells out the date, in the business time zone. */
export function formatDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone,
  }).format(new Date(iso));
}

export function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(
    new Date(iso),
  );
}

const dayMs = 24 * 60 * 60 * 1000;

/** The zone's offset from UTC at that instant, in milliseconds. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
    timeZone,
  }).formatToParts(new Date(utcMs));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((entry) => entry.type === type)!.value);
  const wallMs = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'));
  return wallMs - Math.floor(utcMs / 60_000) * 60_000;
}

const localDateTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * Reads a `datetime-local` value as wall-clock time in `timeZone` (decision 24). Returns null for a time a DST
 * change skips, and the earlier instant for a time that happens twice.
 */
export function wallTimeToUtc(localDateTime: string, timeZone: string): string | null {
  const match = localDateTimePattern.exec(localDateTime);
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute] = match.map(Number);
  const wallMs = Date.UTC(year, month - 1, day, hour, minute);
  const candidates = [wallMs - zoneOffsetMs(wallMs - dayMs, timeZone), wallMs - zoneOffsetMs(wallMs + dayMs, timeZone)];
  const matching = candidates.filter((utcMs) => utcMs + zoneOffsetMs(utcMs, timeZone) === wallMs);
  return matching.length === 0 ? null : new Date(Math.min(...matching)).toISOString();
}

/** The `datetime-local` value (`YYYY-MM-DDTHH:mm`) of that instant in `timeZone`. */
export function utcToWallTime(iso: string, timeZone: string): string {
  const utcMs = Date.parse(iso);
  return new Date(utcMs + zoneOffsetMs(utcMs, timeZone)).toISOString().slice(0, 16);
}
