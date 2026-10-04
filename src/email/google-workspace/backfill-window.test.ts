import { describe, expect, it, vi } from 'vitest';

vi.mock('@karmaniverous/jeeves', () => ({
  nowIso: () => '2026-10-04T00:00:00.000Z',
}));
vi.mock('./email-fetch.js', () => ({ fetchThreadMetadata: vi.fn() }));
vi.mock('./email-triage.js', () => ({
  classifyBucket: () => 'Bucket',
  computeLabelsToApply: () => ['Receipts'],
  classifyCandidates: () => ({ receiptCandidate: true, junkCandidate: false }),
}));

import type { EmailStoreClient } from '../email-state.js';
import {
  BACKFILL_STATE_NAMESPACE,
  backfillAccount,
  backfillCursorKey,
  type BackfillDeps,
  backfillQuery,
  nextBackfillWindow,
} from './backfill-window.js';
import { fetchThreadMetadata } from './email-fetch.js';
import type { GogRunner } from './gmail-search.js';
import { EMAIL_UPDATES_QUEUE } from './label-actions.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-04T00:00:00.000Z');
const SETTINGS = { lookbackDays: 10, windowDays: 4 };
const ACCOUNT = 'me@example.com';
const CURSOR = `${BACKFILL_STATE_NAMESPACE}|${backfillCursorKey(ACCOUNT)}`;
const SEEN = `email|${ACCOUNT}.seenThreadIds`;

/** Minimal in-memory runner store. */
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
    setItem: vi.fn((ns: string, key: string, id: string, v?: string) => {
      items.set(`${ns}|${key}|${id}`, v ?? '');
    }),
    enqueue: vi.fn((name: string, payload: unknown) => {
      queue.push({ name, payload });
      return queue.length;
    }),
  } satisfies EmailStoreClient;
  return { client, state, items, queue };
}

/** gog stub returning the given pages (thread ids) in order. */
function pagedGog(
  pages: Array<{ ids: string[]; next: string }>,
): GogRunner & { calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const fn = (args: string[]) => {
    calls.push(args);
    const p = pages[i++] ?? { ids: [], next: '' };
    return JSON.stringify({
      threads: p.ids.map((id) => ({ id, labels: ['INBOX'] })),
      nextPageToken: p.next,
    });
  };
  return Object.assign(fn, { calls });
}

function deps(
  client: EmailStoreClient,
  gog: GogRunner,
  over: Partial<BackfillDeps> = {},
): BackfillDeps {
  return { client, gog, now: NOW, live: true, reportOnly: false, ...over };
}

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
    const at = new Date(NOW.getTime() - 10 * DAY).toISOString();
    const past = new Date(NOW.getTime() - 11 * DAY).toISOString();
    expect(nextBackfillWindow(at, NOW, SETTINGS)).toBeNull();
    expect(nextBackfillWindow(past, NOW, SETTINGS)).toBeNull();
  });

  it('rejects a corrupt cursor', () => {
    expect(() => nextBackfillWindow('garbage', NOW, SETTINGS)).toThrow(
      /Invalid backfill cursor "garbage"/,
    );
  });
});

describe('backfillQuery', () => {
  it('uses epoch seconds, flooring sub-second instants', () => {
    expect(
      backfillQuery({
        after: new Date('2026-01-01T00:00:00Z'),
        before: new Date('2026-01-02T00:00:00.999Z'),
      }),
    ).toBe('after:1767225600 before:1767312000');
  });
});

describe('backfillAccount', () => {
  it('walks back one window per run, then no-ops', () => {
    const { client, state } = fakeClient();
    const gog = pagedGog([]);
    const d = deps(client, gog);

    const r1 = backfillAccount(ACCOUNT, SETTINGS, d);
    expect(r1.window?.before).toEqual(NOW);
    expect(state.get(CURSOR)).toBe(
      new Date(NOW.getTime() - 4 * DAY).toISOString(),
    );
    expect(gog.calls[0][2]).toBe(backfillQuery(r1.window!));

    const r2 = backfillAccount(ACCOUNT, SETTINGS, d);
    expect(r2.window?.before).toEqual(new Date(NOW.getTime() - 4 * DAY));

    const r3 = backfillAccount(ACCOUNT, SETTINGS, d);
    expect(r3.window?.after).toEqual(new Date(NOW.getTime() - 10 * DAY));
    expect(r3.cursorAdvancedTo).toBe(
      new Date(NOW.getTime() - 10 * DAY).toISOString(),
    );

    const r4 = backfillAccount(ACCOUNT, SETTINGS, d);
    expect(r4).toMatchObject({ window: null, cursorAdvancedTo: null });
    expect(gog.calls).toHaveLength(3);
  });

  it('processes every page of the window and skips known threads', () => {
    const { client, items, queue } = fakeClient();
    items.set(`${SEEN}|known`, '{}');
    const gog = pagedGog([
      { ids: ['new1', 'known'], next: 'p2' },
      { ids: ['new2'], next: '' },
    ]);
    const r = backfillAccount(ACCOUNT, SETTINGS, deps(client, gog));
    expect(r).toMatchObject({
      found: 3,
      known: 1,
      new: 2,
      labelsPlanned: 2,
      labelsEnqueued: 2,
    });
    expect(queue.map((q) => q.name)).toEqual([
      EMAIL_UPDATES_QUEUE,
      EMAIL_UPDATES_QUEUE,
    ]);
    expect(JSON.parse(items.get(`${SEEN}|new2`)!)).toMatchObject({
      bucket: 'Bucket',
      labels: ['INBOX'],
      labelApplied: { Receipts: '2026-10-04T00:00:00.000Z' },
    });
  });

  it('honours the page size', () => {
    const { client } = fakeClient();
    const gog = pagedGog([]);
    backfillAccount(ACCOUNT, SETTINGS, deps(client, gog, { pageSize: 7 }));
    expect(gog.calls[0].slice(3, 5)).toEqual(['--max', '7']);
  });

  it('counts old-format (bare string) thread state as known', () => {
    const { client, items } = fakeClient();
    items.set(`${SEEN}|old`, '2026-01-01T00:00:00.000Z');
    const r = backfillAccount(
      ACCOUNT,
      SETTINGS,
      deps(client, pagedGog([{ ids: ['old'], next: '' }])),
    );
    expect(r).toMatchObject({ found: 1, known: 1, new: 0 });
  });

  it('passes reportOnly to the metadata fetch (curation signals)', () => {
    const { client } = fakeClient();
    const fetchMetadata = vi.fn(() => ({ newMessages: 0 }));
    backfillAccount(
      ACCOUNT,
      SETTINGS,
      deps(client, pagedGog([{ ids: ['n'], next: '' }]), {
        reportOnly: true,
        fetchMetadata,
      }),
    );
    expect(fetchMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'n', reportOnly: true }),
    );
    expect(vi.mocked(fetchThreadMetadata)).not.toHaveBeenCalled();
  });

  it('reportOnly: ingests but enqueues no Gmail label actions', () => {
    const { client, items, queue } = fakeClient();
    const gog = pagedGog([{ ids: ['new1'], next: '' }]);
    const r = backfillAccount(
      ACCOUNT,
      SETTINGS,
      deps(client, gog, { reportOnly: true }),
    );
    expect(queue).toEqual([]);
    expect(r).toMatchObject({ new: 1, labelsPlanned: 1, labelsEnqueued: 0 });
    expect(JSON.parse(items.get(`${SEEN}|new1`)!)).toMatchObject({
      labelApplied: {},
    });
    expect(r.cursorAdvancedTo).not.toBeNull();
  });

  it('dry-run writes nothing and does not move the cursor', () => {
    const { client, queue, state } = fakeClient();
    const gog = pagedGog([{ ids: ['new1'], next: '' }]);
    const r = backfillAccount(
      ACCOUNT,
      SETTINGS,
      deps(client, gog, { live: false }),
    );
    expect(r).toMatchObject({
      new: 1,
      labelsPlanned: 1,
      labelsEnqueued: 0,
      cursorAdvancedTo: null,
    });
    expect(queue).toEqual([]);
    expect(client.setItem).not.toHaveBeenCalled();
    expect(state.size).toBe(0);
  });

  it('leaves the cursor in place when the search fails', () => {
    const { client, state } = fakeClient();
    const gog = () => {
      throw new Error('gog down');
    };
    expect(() => backfillAccount(ACCOUNT, SETTINGS, deps(client, gog))).toThrow(
      /gog down/,
    );
    expect(state.size).toBe(0);
  });

  it('a failure on a later page keeps the cursor; the retry skips stored threads', () => {
    const { client, state } = fakeClient();
    let fail = true;
    const gog: GogRunner = (args) => {
      if (!args.includes('p2'))
        return JSON.stringify({ threads: [{ id: 'a' }], nextPageToken: 'p2' });
      if (fail) {
        fail = false;
        throw new Error('page 2 failed');
      }
      return JSON.stringify({ threads: [{ id: 'b' }], nextPageToken: '' });
    };
    expect(() => backfillAccount(ACCOUNT, SETTINGS, deps(client, gog))).toThrow(
      /page 2 failed/,
    );
    expect(state.has(CURSOR)).toBe(false);

    const r = backfillAccount(ACCOUNT, SETTINGS, deps(client, gog));
    expect(r).toMatchObject({ found: 2, known: 1, new: 1 });
    expect(state.get(CURSOR)).toBe(r.window?.after.toISOString());
  });

  it('rejects malformed gog output without advancing the cursor', () => {
    const { client, state, queue } = fakeClient();
    const gog = () => JSON.stringify({ threads: [{ id: 1 }] });
    expect(() => backfillAccount(ACCOUNT, SETTINGS, deps(client, gog))).toThrow(
      /Unexpected gog gmail search output/,
    );
    expect(state.size).toBe(0);
    expect(queue).toEqual([]);
  });
});
