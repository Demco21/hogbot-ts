/**
 * Timezone-aware calendar helpers shared by the scheduled per-guild features
 * (beers channel renaming, voice streak rollover). All functions take an IANA
 * timezone name (e.g. 'America/New_York') and use Intl, so DST is handled for us.
 */

export const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * Calendar date in the given timezone as 'YYYY-MM-DD'. The en-CA locale formats
 * dates in ISO order, so these strings sort and compare correctly as plain strings.
 */
export function getDateInTimezone(timezone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * Shift a 'YYYY-MM-DD' date string by a number of calendar days. Pure date
 * arithmetic (done in UTC), independent of any timezone or DST transition.
 */
export function shiftDate(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Day of the week in the given timezone, 0 (Sunday) through 6 (Saturday).
 */
export function getDayOfWeekInTimezone(timezone: string, at: Date = new Date()): number {
  const dayName = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(at);
  return DAYS_OF_WEEK.indexOf(dayName as (typeof DAYS_OF_WEEK)[number]);
}

/**
 * Seconds elapsed since local midnight in the given timezone.
 */
function getSecondsSinceMidnight(timezone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);

  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);

  return value('hour') * 3600 + value('minute') * 60 + value('second');
}

/**
 * The instant of the next local midnight in the given timezone.
 *
 * Starts from "now + time remaining in a 24h day", then corrects once by however far
 * that candidate lands from local midnight - which is non-zero only when a DST
 * transition happens before midnight (the day is 23 or 25 hours long).
 */
export function getNextMidnight(timezone: string, now: Date = new Date()): Date {
  const candidate = new Date(now.getTime() + (SECONDS_PER_DAY - getSecondsSinceMidnight(timezone, now)) * 1000);

  const drift = getSecondsSinceMidnight(timezone, candidate);
  if (drift === 0) return candidate;

  // Landed just after midnight (short day) → step back; just before (long day) → step forward
  const correction = drift > SECONDS_PER_DAY / 2 ? drift - SECONDS_PER_DAY : drift;
  return new Date(candidate.getTime() - correction * 1000);
}
