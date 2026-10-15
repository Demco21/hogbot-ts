/**
 * Timezone-aware calendar helpers shared by the scheduled per-guild features
 * (beers channel renaming, voice streak rollover). All functions take an IANA
 * timezone name (e.g. 'America/New_York') and use Intl, so DST is handled for us.
 *
 * Helpers that take a `dayStartHour` support "days" that begin at a local hour other
 * than midnight (e.g. 5 → each day runs 05:00-04:59). The default of 0 is midnight.
 */

export const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * Local wall-clock date and time in the given timezone, as numeric parts.
 */
function getLocalParts(
  timezone: string,
  at: Date
): { year: string; month: string; day: string; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);

  const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '0';

  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: Number(value('hour')),
    minute: Number(value('minute')),
    second: Number(value('second')),
  };
}

/**
 * The day `at` falls in, in the given timezone, as 'YYYY-MM-DD'. ISO order means these
 * strings sort and compare correctly as plain strings.
 *
 * With a `dayStartHour`, times before that hour belong to the previous day - e.g. with
 * 5, 02:00 on the 16th returns the 15th. Uses the local hour (not an instant offset),
 * so the day still starts at exactly that hour on DST-transition days.
 */
export function getDateInTimezone(timezone: string, at: Date = new Date(), dayStartHour = 0): string {
  const { year, month, day, hour } = getLocalParts(timezone, at);
  const calendarDate = `${year}-${month}-${day}`;
  return hour < dayStartHour ? shiftDate(calendarDate, -1) : calendarDate;
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
 * Seconds elapsed since the most recent local `dayStartHour`:00 in the given timezone.
 */
function getSecondsSinceDayStart(timezone: string, at: Date, dayStartHour: number): number {
  const { hour, minute, second } = getLocalParts(timezone, at);
  const secondsSinceMidnight = hour * 3600 + minute * 60 + second;
  return (secondsSinceMidnight - dayStartHour * 3600 + SECONDS_PER_DAY) % SECONDS_PER_DAY;
}

/**
 * The instant the next day starts (local `dayStartHour`:00) in the given timezone.
 *
 * Starts from "now + time remaining in a 24h day", then corrects once by however far
 * that candidate lands from the day start - which is non-zero only when a DST
 * transition happens before the next day start (the day is 23 or 25 hours long).
 */
export function getNextDayStart(timezone: string, dayStartHour = 0, now: Date = new Date()): Date {
  const candidate = new Date(
    now.getTime() + (SECONDS_PER_DAY - getSecondsSinceDayStart(timezone, now, dayStartHour)) * 1000
  );

  const drift = getSecondsSinceDayStart(timezone, candidate, dayStartHour);
  if (drift === 0) return candidate;

  // Landed just after the day start (short day) → step back; just before (long day) → step forward
  const correction = drift > SECONDS_PER_DAY / 2 ? drift - SECONDS_PER_DAY : drift;
  return new Date(candidate.getTime() - correction * 1000);
}
