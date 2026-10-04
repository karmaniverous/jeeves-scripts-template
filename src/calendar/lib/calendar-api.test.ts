import { afterEach, describe, expect, it, vi } from 'vitest';

import { getAllEvents, listCalendars } from './calendar-api.js';

/** Fake Calendar API: serves `pages[pageToken ?? '']` and records URLs. */
function fakeApi(pages: Record<string, unknown>, status = 200) {
  const urls: URL[] = [];
  const auth: string[] = [];
  const fetchMock = vi.fn((input: URL, init?: RequestInit) => {
    const url = new URL(input);
    urls.push(url);
    auth.push(new Headers(init?.headers).get('Authorization') ?? '');
    const body = pages[url.searchParams.get('pageToken') ?? ''];
    return Promise.resolve(
      new Response(status === 200 ? JSON.stringify(body) : 'denied', {
        status,
      }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return { urls, auth };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listCalendars', () => {
  it('returns the calendars from every calendarList page', async () => {
    const api = fakeApi({
      '': { items: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'p2' },
      p2: { items: [{ id: 'c' }], nextPageToken: 'p3' },
      p3: { items: [] },
    });
    const calendars = await listCalendars('tok');
    expect(calendars.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(api.urls.map((u) => u.searchParams.get('pageToken'))).toEqual([
      null,
      'p2',
      'p3',
    ]);
    expect(api.urls[0].pathname).toBe('/calendar/v3/users/me/calendarList');
    expect(api.auth).toEqual(['Bearer tok', 'Bearer tok', 'Bearer tok']);
  });

  it('returns no calendars for a page without items', async () => {
    fakeApi({ '': {} });
    expect(await listCalendars('tok')).toEqual([]);
  });

  it('throws with the status and body on an error response', async () => {
    fakeApi({}, 403);
    await expect(listCalendars('tok')).rejects.toThrow(
      'calendarList failed: 403 denied',
    );
  });
});

describe('getAllEvents', () => {
  it('pages through the events with the query kept on every page', async () => {
    const api = fakeApi({
      '': { items: [{ id: 'e1' }], nextPageToken: 'n' },
      n: { items: [{ id: 'e2' }] },
    });
    const events = await getAllEvents('tok', 'team@x.test', 'T0', 'T1');
    expect(events.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(api.urls[0].pathname).toBe(
      '/calendar/v3/calendars/team%40x.test/events',
    );
    for (const u of api.urls) {
      expect(u.searchParams.get('timeMin')).toBe('T0');
      expect(u.searchParams.get('timeMax')).toBe('T1');
      expect(u.searchParams.get('singleEvents')).toBe('true');
    }
    expect(api.urls[1].searchParams.get('pageToken')).toBe('n');
  });

  it('names the calendar when the request fails', async () => {
    fakeApi({}, 404);
    await expect(getAllEvents('tok', 'cal-1', 'T0', 'T1')).rejects.toThrow(
      'events.list failed (cal-1): 404 denied',
    );
  });
});
