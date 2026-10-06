import { describe, expect, it, vi } from 'vitest';

vi.mock('@karmaniverous/jeeves', () => ({
  nowIso: () => '2026-10-06T00:00:00.000Z',
}));

import { EMAIL_UPDATES_QUEUE } from '../../email/google-workspace/label-actions.js';
import {
  catchUpMeetingEmailActions,
  deferMeetingEmailActions,
  messageKey,
  PENDING_COLLECTION,
  PENDING_NAMESPACE,
  type PendingClient,
} from './pending-actions.js';

interface Queued {
  action: string;
  label?: string;
  messageId: string;
}

/** In-memory runner client: items keyed by collection, plus an enqueue log. */
function fakeClient() {
  const items = new Map<string, Map<string, string>>();
  const queued: Queued[] = [];
  const coll = (ns: string, key: string) => {
    const k = `${ns}/${key}`;
    let m = items.get(k);
    if (!m) items.set(k, (m = new Map<string, string>()));
    return m;
  };
  const client: PendingClient = {
    getItem: (ns, key, item) => coll(ns, key).get(item) ?? null,
    setItem: (ns, key, item, value) => {
      coll(ns, key).set(item, value ?? '');
    },
    deleteItem: (ns, key, item) => {
      coll(ns, key).delete(item);
    },
    listItemKeys: (ns, key) => [...coll(ns, key).keys()],
    enqueue: (queue, payload) => {
      expect(queue).toBe(EMAIL_UPDATES_QUEUE);
      queued.push(payload as Queued);
      return queued.length;
    },
  };
  const pending = () => coll(PENDING_NAMESPACE, PENDING_COLLECTION);
  return { client, queued, pending };
}

const msg = (id: string) => ({
  account: 'me@example.com',
  threadId: `t-${id}`,
  messageId: id,
});

describe('deferMeetingEmailActions', () => {
  it('records the message as pending, keyed by source key', () => {
    const { client, pending, queued } = fakeClient();
    // A cache candidate carries more than the message ids; only ids are kept.
    const candidate = { ...msg('a'), labels: ['INBOX'], subject: 's' };
    deferMeetingEmailActions(client, 'gemini:t-a:a', candidate);
    expect(JSON.parse(pending().get('gemini:t-a:a') ?? '')).toEqual(msg('a'));
    expect(queued).toHaveLength(0);
  });
});

describe('catchUpMeetingEmailActions', () => {
  it('does nothing when nothing is pending (no migration of old meetings)', () => {
    const { client, queued } = fakeClient();
    expect(catchUpMeetingEmailActions(client, new Map())).toEqual({
      caughtUp: 0,
      queued: 0,
      remaining: 0,
    });
    expect(queued).toHaveLength(0);
  });

  it('uses current labels: archives an inbox message, never a watched one', () => {
    const { client, queued, pending } = fakeClient();
    deferMeetingEmailActions(client, 'k-a', msg('a'));
    deferMeetingEmailActions(client, 'k-b', msg('b'));
    const labels = new Map([
      [messageKey(msg('a')), ['INBOX']],
      [messageKey(msg('b')), ['INBOX', 'watch']],
    ]);
    const r = catchUpMeetingEmailActions(client, labels);
    expect(r).toEqual({ caughtUp: 2, queued: 3, remaining: 0 });
    expect(queued.map((q) => `${q.messageId}:${q.action}`)).toEqual([
      'a:addLabel',
      'a:archive',
      'b:addLabel',
    ]);
    expect(pending().size).toBe(0);
  });

  it('labels only when the message is no longer in the cache', () => {
    const { client, queued } = fakeClient();
    deferMeetingEmailActions(client, 'k-a', msg('a'));
    catchUpMeetingEmailActions(client, new Map());
    expect(queued.map((q) => q.action)).toEqual(['addLabel']);
  });

  it('honours archive: false', () => {
    const { client, queued } = fakeClient();
    deferMeetingEmailActions(client, 'k-a', msg('a'));
    catchUpMeetingEmailActions(
      client,
      new Map([[messageKey(msg('a')), ['INBOX']]]),
      { archive: false },
    );
    expect(queued.map((q) => q.action)).toEqual(['addLabel']);
  });

  it('caps each run and leaves the rest pending', () => {
    const { client, queued } = fakeClient();
    for (const id of ['a', 'b', 'c'])
      deferMeetingEmailActions(client, `k-${id}`, msg(id));
    expect(catchUpMeetingEmailActions(client, new Map(), { limit: 2 })).toEqual(
      {
        caughtUp: 2,
        queued: 2,
        remaining: 1,
      },
    );
    expect(catchUpMeetingEmailActions(client, new Map(), { limit: 2 })).toEqual(
      {
        caughtUp: 1,
        queued: 1,
        remaining: 0,
      },
    );
    expect(queued).toHaveLength(3);
  });

  it('is idempotent: a second pass enqueues nothing', () => {
    const { client, queued } = fakeClient();
    deferMeetingEmailActions(client, 'k-a', msg('a'));
    catchUpMeetingEmailActions(client, new Map());
    catchUpMeetingEmailActions(client, new Map());
    expect(queued).toHaveLength(1);
  });

  it('drops a malformed record without enqueueing', () => {
    const { client, queued, pending } = fakeClient();
    pending().set('bad', '{"account":1}');
    expect(catchUpMeetingEmailActions(client, new Map()).caughtUp).toBe(0);
    expect(queued).toHaveLength(0);
    expect(pending().size).toBe(0);
  });
});
