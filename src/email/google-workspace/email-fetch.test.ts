import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@karmaniverous/jeeves', () => ({
  appendJsonl: vi.fn(),
  ensureDir: vi.fn(),
  nowIso: () => '2026-10-04T00:00:00.000Z',
}));
vi.mock('../../lib/gog.js', () => ({ gogWithRetry: vi.fn() }));
vi.mock('../email-cache.js', () => ({
  createOrUpdateCache: vi.fn(),
  detectLabelChanges: vi.fn(() => []),
  loadCache: vi.fn(),
}));
vi.mock('./email-triage.js', () => ({
  pendingKey: (a: string, t: string) => `${a}|${t}`,
  shouldExpectResponse: () => false,
}));

import { gogWithRetry } from '../../lib/gog.js';
import { loadCache } from '../email-cache.js';
import type { EmailStoreClient } from '../email-state.js';
import { fetchThreadMetadata } from './email-fetch.js';
import { EMAIL_UPDATES_QUEUE } from './label-actions.js';

const ACCOUNT = 'me@example.com';

function fakeClient() {
  const items = new Map<string, string>();
  const queue: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const client = {
    getState: vi.fn(() => null),
    setState: vi.fn(),
    getItem: vi.fn(
      (ns: string, key: string, id: string) =>
        items.get(`${ns}|${key}|${id}`) ?? null,
    ),
    setItem: vi.fn((ns: string, key: string, id: string, v?: string) => {
      items.set(`${ns}|${key}|${id}`, v ?? '');
    }),
    enqueue: vi.fn((name: string, payload: unknown) => {
      queue.push({ name, payload: payload as Record<string, unknown> });
      return queue.length;
    }),
  } satisfies EmailStoreClient;
  return { client, items, queue };
}

function run(client: EmailStoreClient, reportOnly: boolean) {
  return fetchThreadMetadata({
    account: ACCOUNT,
    threadId: 't1',
    subject: 'Hi',
    from: 'a@example.com',
    to: ACCOUNT,
    receiptCandidate: false,
    junkCandidate: false,
    bucket: null,
    labels: ['INBOX'],
    query: 'q',
    client,
    reportOnly,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // The message was seen before and was archived; it is now back in
  // the inbox, which is a human curation signal.
  vi.mocked(gogWithRetry).mockReturnValue(
    JSON.stringify({
      thread: {
        messages: [{ id: 'm1', internalDate: '1000', labelIds: ['INBOX'] }],
      },
    }),
  );
  vi.mocked(loadCache).mockReturnValue({
    threadId: 't1',
    account: ACCOUNT,
    subject: 'Hi',
    participants: [],
    messages: {
      m1: {
        messageId: 'm1',
        from: '',
        to: '',
        cc: '',
        date: null,
        internalDateMs: 1000,
        labels: ['CATEGORY_UPDATES'],
        snippet: '',
        hasAttachments: false,
        attachments: [],
      },
    },
    provenance: [],
    cachedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
});

function seed(items: Map<string, string>): void {
  items.set(
    `email|${ACCOUNT}.seenThreadIds|t1`,
    JSON.stringify({ seenMessageIds: { m1: '2026-01-01T00:00:00.000Z' } }),
  );
}

describe('fetchThreadMetadata curation signals', () => {
  it('enqueues the curation action when not reportOnly', () => {
    const { client, items, queue } = fakeClient();
    seed(items);
    run(client, false);
    expect(queue.map((q) => q.name)).toEqual([EMAIL_UPDATES_QUEUE]);
    expect(queue[0].payload).toMatchObject({
      action: 'addLabel',
      label: 'watch',
      messageId: 'm1',
    });
  });

  it('enqueues nothing on email-updates in reportOnly', () => {
    const { client, items, queue } = fakeClient();
    seed(items);
    run(client, true);
    expect(queue.filter((q) => q.name === EMAIL_UPDATES_QUEUE)).toEqual([]);
    // Ingest still happens: thread state is written.
    expect(
      JSON.parse(items.get(`email|${ACCOUNT}.seenThreadIds|t1`)!),
    ).toMatchObject({ lastInternalDateMs: 1000 });
  });

  it('still queues a new message for download in reportOnly', () => {
    const { client, queue } = fakeClient();
    const r = run(client, true);
    expect(r.newMessages).toBe(1);
    expect(queue.map((q) => q.name)).toEqual(['email-pending']);
  });
});
