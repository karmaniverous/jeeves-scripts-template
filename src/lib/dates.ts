/**
 * @module dates
 *
 * Date formatting and date-context utilities — thin wrappers around date-fns.
 *
 * LLMs cannot do day-of-week arithmetic reliably; always call these
 * helpers instead of computing dates inline. Used by meeting extractors,
 * email classification, and any script that formats dates for human output.
 *
 * No config dependencies — this module is purely functional.
 */

import {
  differenceInCalendarDays,
  format,
  formatDistance,
  parseISO,
} from 'date-fns';

export { format, parseISO };

/**
 * Return the full weekday name for a date string (e.g. "Monday").
 *
 * @param dateStr - ISO 8601 date string (YYYY-MM-DD or full ISO)
 */
export function dayOfWeek(dateStr: string): string {
  return format(parseISO(dateStr), 'EEEE');
}

/**
 * Format a date string using a date-fns format pattern.
 *
 * @param dateStr - ISO 8601 date string
 * @param fmt     - date-fns format string (e.g. "yyyy-MM-dd", "EEEE d MMMM yyyy")
 */
export function formatDate(dateStr: string, fmt: string): string {
  return format(parseISO(dateStr), fmt);
}

/**
 * Human-friendly relative description of a date (e.g. "3 days ago",
 * "in 2 days", "today").
 *
 * @param dateStr      - ISO 8601 date string
 * @param referenceStr - Optional ISO 8601 reference date (defaults to now)
 */
export function relativeDays(dateStr: string, referenceStr?: string): string {
  const target = parseISO(dateStr);
  const reference = referenceStr ? parseISO(referenceStr) : new Date();
  const diff = differenceInCalendarDays(target, reference);

  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';

  return formatDistance(target, reference, { addSuffix: true });
}

/**
 * Validate a time zone read from instance config. There is no default:
 * an empty or unknown zone throws, naming where to set it.
 *
 * @param value  - Configured zone (IANA name such as `America/Chicago`, or `UTC`)
 * @param source - Where the value is configured, for the error message
 * @returns The zone as given.
 */
export function requireTimeZone(value: string, source: string): string {
  if (!value)
    throw new Error(
      `No time zone configured: set ${source} to an IANA time zone (e.g. "America/Chicago" or "UTC")`,
    );
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch {
    throw new Error(
      `Invalid time zone "${value}" in ${source}: use an IANA time zone (e.g. "America/Chicago" or "UTC")`,
    );
  }
  return value;
}

/**
 * Prepend an authoritative date line to a worker task, so the worker never
 * guesses today's date: `> **Today is Monday, 2026-05-11 (UTC).** …`.
 *
 * @param task     - Task text
 * @param now      - The current instant
 * @param timeZone - Zone the date is computed in (see {@link requireTimeZone})
 */
export function withDateContext(
  task: string,
  now: Date,
  timeZone: string,
): string {
  const dayName = now.toLocaleDateString('en-US', {
    weekday: 'long',
    timeZone,
  });
  const dateStr = now.toLocaleDateString('en-CA', { timeZone }); // YYYY-MM-DD
  return (
    `> **Today is ${dayName}, ${dateStr} (${timeZone}).** Use this as the authoritative date reference for all dates in this report.\n\n` +
    task
  );
}
