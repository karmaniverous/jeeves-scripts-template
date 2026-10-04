import type { RunnerClient } from '@karmaniverous/jeeves-runner';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@karmaniverous/jeeves', () => ({
  nowIso: () => '2026-10-04T00:00:00.000Z',
}));
vi.mock('./email-fetch.js', () => ({ fetchThreadMetadata: vi.fn() }));
vi.mock('./email-triage.js', () => ({
  classifyBucket: () => 'Bucket',
  computeLabelsToApply: () => ['Receipts'],
  isJunkCandidate: () => false,
  isReceiptCandidate: () => true,
}));

import {
  BACKFILL_STATE_NAMESPACE,
  backfillAccount,
  backfillCursorKey,
  backfillQuery,
  type GogRunner,
  nextBackfillWindow,
  resolveBackfillSettings,
  searchAllThreads,
} from './backfill-window.js';
import { EMAIL_UPDATES_QUEUE } from './label-actions.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-04T00:00:00.000Z');
const SETTINGS = {
  accounts: ['me@example.com'],
  lookbackDays: 10,
  windowDays: 4,
};

/** Minimal in-memory runner client. */
function fakeClient() {
  const state = new Map<string, string>();
  const items = new Map<string, string>();
  const queue: Array<{ name: string; payload: unknown }> = [];
  const client = {
    getState: vi.fn(
      (ns: string, key: string) => state.get(`${ns}|${key}`) ?? null,
    ),
    setState: vi.fn((ns: string, key: string, v: string) => {
      state.set(`${ns}|${key}`, v);
    }),
    getItem: vi.fn(
      (ns: string, key: string, id: string) =>
        items.get(`${ns}|${key}|${id}`) ?? null,
    ),
    setItem: vi.fn((ns: string, key: string, id: string, v: string) => {
      items.set(`${ns}|${key}|${id}`, v);
    }),
    enqueue: vi.fn((name: string, payload: unknown) => {
      queue.push({ name, payload });
    }),
  };
  return {
    client: client as unknown as RunnerClient,
    raw: client,
    state,
    queue,
  };
}

/** gog stub returning the given pages in order. */
function pagedGog(
  pages: Array<{ threads: Array<Record<string, unknown>>; next: string }>,
): GogRunner & { calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const fn = (args: string[]) => {
    calls.push(args);
    const p = pages[i++] ?? { threads: [], next: '' };
    return JSON.stringify({ threads: p.threads, nextPageToken: p.next });
  };
  return Object.assign(fn, { calls });
}

describe('resolveBackfillSettings', () => {
  it('uses emailConfig.backfill', () => {
    expect(resolveBackfillSettings(SETTINGS, [])).toEqual(SETTINGS);
  });

  it('lets CLI args override config per field', () => {
    expect(
      resolveBackfillSettings(SETTINGS, [
        '--accounts',
        'a@example.com, b@example.com',
        '--window-days',
        '2',
      ]),
    ).toEqual({
      accounts: ['a@example.com', 'b@example.com'],
      lookbackDays: 10,
      windowDays: 2,
    });
  });

  it('works from CLI args alone', () => {
    expect(
      resolveBackfillSettings(undefined, [
        '--accounts',
        'a@example.com',
        '--lookback-days',
        '90',
        '--window-days',
        '7',
      ]),
    ).toEqual({ accounts: ['a@example.com'], lookbackDays: 90, windowDays: 7 });
  });

  it('has no defaults: missing config and args is an error', () => {
    expect(() => resolveBackfillSettings(undefined, [])).toThrow(
      /missing accounts \(--accounts\), lookbackDays \(--lookback-days\), windowDays \(--window-days\).*no defaults/,
    );
    expect(() =>
      resolveBackfillSettings(undefined, ['--accounts', 'a@example.com']),
    ).toThrow(/missing lookbackDays/);
    expect(() =>
      resolveBackfillSettings(undefined, ['--accounts', ' , ']),
    ).toThrow(/missing accounts/);
  });

  it('rejects non-positive day counts', () => {
    expect(() =>
      resolveBackfillSettings(SETTINGS, ['--window-days', '0']),
    ).toThrow(/--window-days must be a positive integer/);
  });
});

describe('nextBackfillWindow', () => {
  it('starts at now when there is no cursor', () => {
    expect(nextBackfillWindow(null, NOW, SETTINGS)).toEqual({
      after: new Date(NOW.getTime() - 4 * DAY),
      before: NOW,
    });
  });

  it('clamps the last window to the lookback limit', () => {
    const cursor = new Date(NOW.getTime() - 8 * DAY).toISOString();
    expect(nextBackfillWindow(cursor, NOW, SETTINGS)).toEqual({
      after: new Date(NOW.getTime() - 10 * DAY),
      before: new Date(cursor),
    });
  });

  it('returns null at or past the lookback limit', () => {
    const cursor = new Date(NOW.getTime() - 10 * DAY).toISOString();
    expect(nextBackfillWindow(cursor, NOW, SETTINGS)).toBeNull();
  });

  it('rejects a corrupt cursor', () => {
    expect(() => nextBackfillWindow('garbage', NOW, SETTINGS)).toThrow(
      /Invalid backfill cursor/,
    );
  });
});

describe('backfillQuery', () => {
  it('uses epoch seconds', () => {
    expect(
      backfillQuery({
        after: new Date('2026-01-01T00:00:00Z'),
        before: new Date('2026-01-02T00:00:00Z'),
      }),
    ).toBe('after:1767225600 before:1767312000');
  });
});

describe('searchAllThreads', () => {
  it('follows nextPageToken until empty', () => {
    const gog = pagedGog([
      { threads: [{ id: 't1' }, { id: 't2' }], next: 'p2' },
      { threads: [{ id: 't3' }], next: 'p3' },
      { threads: [{ id: 't4' }], next: '' },
    ]);
    const threads = searchAllThreads(gog, 'me@example.com', 'q', 2);
    expect(threads.map((t) => t.id)).toEqual(['t1', 't2', 't3', 't4']);
    expect(gog.calls).toHaveLength(3);
    expect(gog.calls[0]).toEqual([
      'gmail',
      'search',
      'q',
      '--max',
      '2',
      '--json',
      '--account',
      'me@example.com',
    ]);
    expect(gog.calls[1].slice(-2)).toEqual(['--page', 'p2']);
    expect(gog.calls[2].slice(-2)).toEqual(['--page', 'p3']);
  });

  it('handles empty output and null threads', () => {
    expect(searchAllThreads(() => '', 'a', 'q')).toEqual([]);
    expect(
      searchAllThreads(
        () => JSON.stringify({ threads: null, nextPageToken: '' }),
        'a',
        'q',
      ),
    ).toEqual([]);
  });

  it('throws on a repeated page token instead of looping forever', () => {
    const gog = () => JSON.stringify({ threads: [], nextPageToken: 'same' });
    expect(() => searchAllThreads(gog, 'a', 'q')).toThrow(
      /repeated page token/,
    );
  });
});

describe('backfillAccount', () => {
  const account = 'me@example.com';
  const key = `${BACKFILL_STATE_NAMESPACE}|${backfillCursorKey(account)}`;

  it('walks back one window per run, then no-ops', () => {
    const { client, state } = fakeClient();
    const gog = pagedGog([]);
    const deps = { client, gog, now: NOW, live: true, reportOnly: false };

    const r1 = backfillAccount(account, SETTINGS, deps);
    expect(r1.window?.before).toEqual(NOW);
    expect(state.get(key)).toBe(
      new Date(NOW.getTime() - 4 * DAY).toISOString(),
    );

    const r2 = backfillAccount(account, SETTINGS, deps);
    expect(r2.window?.before).toEqual(new Date(NOW.getTime() - 4 * DAY));
    expect(state.get(key)).toBe(
      new Date(NOW.getTime() - 8 * DAY).toISOString(),
    );

    const r3 = backfillAccount(account, SETTINGS, deps);
    expect(r3.window?.after).toEqual(new Date(NOW.getTime() - 10 * DAY));
    expect(state.get(key)).toBe(
      new Date(NOW.getTime() - 10 * DAY).toISOString(),
    );

    const r4 = backfillAccount(account, SETTINGS, deps);
    expect(r4.window).toBeNull();
    expect(gog.calls).toHaveLength(3);
  });

  it('processes every page of the window and skips known threads', () => {
    const { client, raw, queue } = fakeClient();
    raw.setItem('email', `${account}.seenThreadIds`, 'known', '{}');
    const gog = pagedGog([
      { threads: [{ id: 'new1' }, { id: 'known' }], next: 'p2' },
      { threads: [{ id: 'new2' }], next: '' },
    ]);
    const r = backfillAccount(account, SETTINGS, {
      client,
      gog,
      now: NOW,
      live: true,
      reportOnly: false,
    });
    expect(r).toMatchObject({ found: 3, known: 1, new: 2, labelsEnqueued: 2 });
    expect(queue.map((q) => q.name)).toEqual([
      EMAIL_UPDATES_QUEUE,
      EMAIL_UPDATES_QUEUE,
    ]);
    expect(raw.getItem('email', `${account}.seenThreadIds`, 'new2')).toContain(
      '"bucket":"Bucket"',
    );
  });

  it('reportOnly: ingests but enqueues no Gmail label actions', () => {
    const { client, raw, queue } = fakeClient();
    const gog = pagedGog([{ threads: [{ id: 'new1' }], next: '' }]);
    const r = backfillAccount(account, SETTINGS, {
      client,
      gog,
      now: NOW,
      live: true,
      reportOnly: true,
    });
    expect(queue).toEqual([]);
    expect(r).toMatchObject({ new: 1, labelsPlanned: 1, labelsEnqueued: 0 });
    expect(raw.setItem).toHaveBeenCalled();
    expect(r.cursorAdvancedTo).not.toBeNull();
  });

  it('dry-run writes nothing and does not move the cursor', () => {
    const { client, raw, queue, state } = fakeClient();
    const gog = pagedGog([{ threads: [{ id: 'new1' }], next: '' }]);
    const r = backfillAccount(account, SETTINGS, {
      client,
      gog,
      now: NOW,
      live: false,
      reportOnly: false,
    });
    expect(r).toMatchObject({
      new: 1,
      labelsPlanned: 1,
      cursorAdvancedTo: null,
    });
    expect(queue).toEqual([]);
    expect(raw.setItem).not.toHaveBeenCalled();
    expect(state.size).toBe(0);
  });

  it('leaves the cursor in place when the search fails', () => {
    const { client, state } = fakeClient();
    const gog = () => {
      throw new Error('gog down');
    };
    expect(() =>
      backfillAccount(account, SETTINGS, {
        client,
        gog,
        now: NOW,
        live: true,
        reportOnly: false,
      }),
    ).toThrow(/gog down/);
    expect(state.size).toBe(0);
  });
});
