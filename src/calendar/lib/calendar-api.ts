/**
 * @module calendar/lib/calendar-api
 *
 * Google Calendar REST API helpers for listing calendars and events.
 *
 * Pure HTTP wrappers consumed by calendar/poll. Both lists are paged by
 * the API; every page is followed (`nextPageToken`), so callers get every
 * calendar and every event. Callers supply an OAuth access token and
 * receive typed results. No dependency on project constants or config.
 */

const CAL_BASE = 'https://www.googleapis.com/calendar/v3';

export interface CalendarEntry {
  id: string;
  summary?: string;
  accessRole?: string;
}

export interface CalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  status?: string;
  attendees?: Array<{ email: string; responseStatus?: string }>;
  recurrence?: string[];
  updated?: string;
  [key: string]: unknown;
}

/** One page of a Calendar API list response. */
interface ListPage<T> {
  items?: T[];
  nextPageToken?: string;
}

/**
 * Every item of a paged Calendar API list, following `nextPageToken`.
 *
 * @param url - URL of the list, without a page token.
 * @param accessToken - OAuth access token.
 * @param failure - Error message prefix, e.g. `calendarList failed`.
 * @throws On a non-OK response: `<failure>: <status> <body>`.
 */
async function listAllPages<T>(
  url: URL,
  accessToken: string,
  failure: string,
): Promise<T[]> {
  const items: T[] = [];
  let pageToken: string | undefined;
  do {
    const pageUrl = new URL(url);
    if (pageToken) pageUrl.searchParams.set('pageToken', pageToken);
    const resp = await fetch(pageUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`${failure}: ${String(resp.status)} ${body}`);
    }
    const page = (await resp.json()) as ListPage<T>;
    if (page.items) items.push(...page.items);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

/** Every calendar on the account's calendar list (all pages). */
export async function listCalendars(
  accessToken: string,
): Promise<CalendarEntry[]> {
  return listAllPages<CalendarEntry>(
    new URL(`${CAL_BASE}/users/me/calendarList`),
    accessToken,
    'calendarList failed',
  );
}

/**
 * Every event of `calendarId` in `[timeMin, timeMax)` (all pages),
 * recurring events expanded into instances, ordered by start time.
 */
export async function getAllEvents(
  accessToken: string,
  calendarId: string,
  timeMin: string,
  timeMax: string,
): Promise<CalendarEvent[]> {
  const url = new URL(
    `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
  );
  url.search = new URLSearchParams({
    timeMin,
    timeMax,
    maxResults: '250',
    singleEvents: 'true',
    orderBy: 'startTime',
  }).toString();
  return listAllPages<CalendarEvent>(
    url,
    accessToken,
    `events.list failed (${calendarId})`,
  );
}
