import { describe, expect, it, vi } from 'vitest';

vi.mock('@karmaniverous/jeeves', () => ({
  nowIso: () => '2026-10-06T00:00:00.000Z',
}));

import {
  EMAIL_UPDATES_QUEUE,
  type EmailUpdateAction,
} from '../../email/google-workspace/label-actions.js';
import {
  catchUpMeetingEmailActions,
  deferMeetingEmailActions,
  handleNewMeetingEmailActions,
  INVALID_COLLECTION,
  messageKey,
  PENDING_COLLECTION,
  PENDING_NAMESPACE,
  type PendingClient,
} from './pending-actions.js';

const ACTIONS = new Set(['addLabel', 'removeLabel', 'archive']);

/** Narrow an enqueued payload to the email-updates action contract. */
function isEmailUpdate(v: unknown): v is EmailUpdateAction & {
  createdAt: string;
} {
  if (typeof v !== 'object' || v === null) return false;
  const o: Record<string, unknown> = Object.fromEntries(Object.entries(v));
  const strings = ['account', 'threadId', 'messageId', 'source', 'reason'];
  return (
    strings.every((k) => typeof o[k] === 'string') &&
    typeof o['action'] === 'string' &&
    ACTIONS.has(o['action']) &&
    (o['action'] === 'archive' || typeof o['label'] === 'string') &&
    typeof o['createdAt'] === 'string'
  );
}

/** In-memory runner client: items keyed by collection, plus an enqueue log. */
function fakeClient() {
  const items = new Map<string, Map<string, string>>();
  const queued: EmailUpdateAction[] = [];
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
      if (!isEmailUpdate(payload))
        throw new Error(`malformed payload: ${JSON.stringify(payload)}`);
      queued.push(payload);
      return queued.length;
    },
  };
  const pending = () => coll(PENDING_NAMESPACE, PENDING_COLLECTION);
  const invalid = () => coll(PENDING_NAMESPACE, INVALID_COLLECTION);
  return { client, queued, pending, invalid };
}

const msg = (id: string) => ({
  account: 'me@example.com',
  threadId: `t-${id}`,
  messageId: id,
});

describe('handleNewMeetingEmailActions', () => {
  it('enqueues label and archive for an inbox message when reportOnly is off', () => {
    const { client, queued, pending } = fakeClient();
    const res = handleNewMeetingEmailActions(
      client,
      'k-a',
      { ...msg('a'), labels: ['INBOX'] },
      { reportOnly: false },
    );
    expect(res).toEqual({ queued: 2, deferred: false });
    expect(queued.map((q) => q.action)).toEqual(['addLabel', 'archive']);
    expect(pending().size).toBe(0);
  });

  it('honours archive: false when enqueueing', () => {
    const { client, queued } = fakeClient();
    handleNewMeetingEmailActions(
      client,
      'k-a',
      { ...msg('a'), labels: ['INBOX'] },
      { reportOnly: false, archive: false },
    );
    expect(queued.map((q) => q.action)).toEqual(['addLabel']);
  });

  it('defers under reportOnly: nothing enqueued, message recorded as pending', () => {
    const { client, queued, pending } = fakeClient();
    const res = handleNewMeetingEmailActions(
      client,
      'k-a',
      { ...msg('a'), labels: ['INBOX'] },
      { reportOnly: true },
    );
    expect(res).toEqual({ queued: 0, deferred: true });
    expect(queued).toHaveLength(0);
    expect(JSON.parse(pending().get('k-a') ?? '')).toEqual(msg('a'));
  });
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
      invalid: [],
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
    expect(r).toEqual({ caughtUp: 2, queued: 3, remaining: 0, invalid: [] });
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
        invalid: [],
      },
    );
    expect(catchUpMeetingEmailActions(client, new Map(), { limit: 2 })).toEqual(
      {
        caughtUp: 1,
        queued: 1,
        remaining: 0,
        invalid: [],
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

  it('quarantines an unreadable record verbatim and reports it, without enqueueing', () => {
    const { client, queued, pending, invalid } = fakeClient();
    pending().set('bad', '{"account":1}');
    deferMeetingEmailActions(client, 'k-a', msg('a'));
    const res = catchUpMeetingEmailActions(client, new Map());
    expect(res).toMatchObject({ caughtUp: 1, invalid: ['bad'], remaining: 0 });
    expect(queued.map((q) => q.messageId)).toEqual(['a']);
    expect(pending().size).toBe(0);
    expect(invalid().get('bad')).toBe('{"account":1}');
  });

  it('quarantined records are not retried by later runs', () => {
    const { client, queued, invalid } = fakeClient();
    client.setItem(PENDING_NAMESPACE, PENDING_COLLECTION, 'bad', 'not json');
    catchUpMeetingEmailActions(client, new Map());
    expect(catchUpMeetingEmailActions(client, new Map()).invalid).toEqual([]);
    expect(queued).toHaveLength(0);
    expect(invalid().size).toBe(1);
  });
});
