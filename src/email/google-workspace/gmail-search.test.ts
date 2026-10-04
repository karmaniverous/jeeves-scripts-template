import { describe, expect, it } from 'vitest';

import {
  type GogRunner,
  parseSearchPage,
  searchArgs,
  searchThreadPages,
} from './gmail-search.js';

/** gog stub returning the given pages in order. */
function pagedGog(
  pages: Array<{ ids: string[]; next: string }>,
): GogRunner & { calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const fn = (args: string[]) => {
    calls.push(args);
    const p = pages[i++] ?? { ids: [], next: '' };
    return JSON.stringify({
      threads: p.ids.map((id) => ({ id })),
      nextPageToken: p.next,
    });
  };
  return Object.assign(fn, { calls });
}

describe('parseSearchPage', () => {
  it('treats empty output and null threads as an empty last page', () => {
    expect(parseSearchPage('', 'a')).toEqual({
      threads: [],
      nextPageToken: '',
    });
    expect(
      parseSearchPage(
        JSON.stringify({ threads: null, nextPageToken: null }),
        'a',
      ),
    ).toEqual({ threads: [], nextPageToken: '' });
  });

  it('normalises a current gog thread item', () => {
    const out = JSON.stringify({
      threads: [
        {
          id: 't1',
          date: '2026-10-01 10:00',
          internalDateIso: '2026-10-01T10:00:00Z',
          from: 'a@example.com',
          subject: 'Hi',
          labels: ['INBOX'],
          messageCount: 3,
        },
      ],
      nextPageToken: 'p2',
    });
    expect(parseSearchPage(out, 'a')).toEqual({
      threads: [
        {
          threadId: 't1',
          subject: 'Hi',
          snippet: '',
          from: 'a@example.com',
          to: '',
          date: '2026-10-01 10:00',
          messageCount: 3,
          labels: ['INBOX'],
        },
      ],
      nextPageToken: 'p2',
    });
  });

  it('prefers threadId over id and drops items with neither', () => {
    const out = JSON.stringify({
      threads: [
        { threadId: 'tid', id: 'other', snippet: 's', to: 'b@example.com' },
        { id: '' },
        { subject: 'no id' },
      ],
    });
    const page = parseSearchPage(out, 'a');
    expect(page.threads).toHaveLength(1);
    expect(page.threads[0]).toMatchObject({
      threadId: 'tid',
      snippet: 's',
      to: 'b@example.com',
      date: null,
      messageCount: null,
      labels: [],
    });
  });

  it('rejects malformed output before returning any thread', () => {
    const out = JSON.stringify({
      threads: [{ id: 't1' }, { id: 't2', labels: 'INBOX' }],
    });
    expect(() => parseSearchPage(out, 'me@example.com')).toThrow(
      /Unexpected gog gmail search output for me@example\.com/,
    );
    expect(() => parseSearchPage(JSON.stringify({ threads: {} }), 'a')).toThrow(
      /Unexpected gog gmail search output/,
    );
    expect(() =>
      parseSearchPage(JSON.stringify({ threads: [], nextPageToken: 5 }), 'a'),
    ).toThrow(/Unexpected gog gmail search output/);
  });

  it('rejects non-JSON output', () => {
    expect(() => parseSearchPage('not json', 'a')).toThrow(SyntaxError);
  });
});

describe('searchArgs', () => {
  it('adds --page only when there is a token', () => {
    expect(searchArgs('me@example.com', 'q', 5)).toEqual([
      'gmail',
      'search',
      'q',
      '--max',
      '5',
      '--json',
      '--account',
      'me@example.com',
    ]);
    expect(searchArgs('me@example.com', 'q', 5, 'tok').slice(-2)).toEqual([
      '--page',
      'tok',
    ]);
  });
});

describe('searchThreadPages', () => {
  it('follows nextPageToken until empty, one page at a time', () => {
    const gog = pagedGog([
      { ids: ['t1', 't2'], next: 'p2' },
      { ids: ['t3'], next: 'p3' },
      { ids: ['t4'], next: '' },
    ]);
    const pages = searchThreadPages(gog, 'me@example.com', 'q', 2);

    const first = pages.next();
    expect(first.value).toEqual([
      expect.objectContaining({ threadId: 't1' }),
      expect.objectContaining({ threadId: 't2' }),
    ]);
    // Lazy: the second page is not fetched until asked for.
    expect(gog.calls).toHaveLength(1);

    const rest = [...pages].map((p) => p.map((t) => t.threadId));
    expect(rest).toEqual([['t3'], ['t4']]);
    expect(gog.calls).toHaveLength(3);
    expect(gog.calls[0]).toEqual(searchArgs('me@example.com', 'q', 2));
    expect(gog.calls[1].slice(-2)).toEqual(['--page', 'p2']);
    expect(gog.calls[2].slice(-2)).toEqual(['--page', 'p3']);
  });

  it('throws on a repeated page token instead of looping forever', () => {
    const gog = pagedGog([
      { ids: ['t1'], next: 'p2' },
      { ids: ['t2'], next: 'p3' },
      { ids: ['t3'], next: 'p2' },
    ]);
    const seen: string[] = [];
    expect(() => {
      for (const page of searchThreadPages(gog, 'a', 'q', 1)) {
        seen.push(...page.map((t) => t.threadId));
      }
    }).toThrow(/repeated page token for a/);
    expect(seen).toEqual(['t1', 't2', 't3']);
    expect(gog.calls).toHaveLength(3);
  });

  it('throws on a token equal to the previous one', () => {
    const gog = () => JSON.stringify({ threads: [], nextPageToken: 'same' });
    expect(() => [...searchThreadPages(gog, 'a', 'q', 1)]).toThrow(
      /repeated page token/,
    );
  });
});
