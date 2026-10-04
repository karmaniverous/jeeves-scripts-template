import { describe, expect, it, vi } from 'vitest';

vi.mock('@karmaniverous/jeeves', () => ({
  nowIso: () => '2026-10-04T00:00:00.000Z',
}));

import {
  curationSignalActions,
  EMAIL_UPDATES_QUEUE,
  type EmailUpdateAction,
  enqueueEmailUpdates,
  enqueueLabelActions,
  planDrain,
} from './label-actions.js';

const STAMP = '2026-10-04T00:00:00.000Z';
const none = { oauthClient: false, serviceAccount: false, any: false };
const sa = { oauthClient: false, serviceAccount: true, any: true };

function opts(reportOnly: boolean) {
  return {
    account: 'me@example.com',
    threadId: 't1',
    messageId: 'm1',
    labels: ['Receipts', 'Bucket/A'],
    source: 'poll-classification',
    reason: 'test',
    reportOnly,
  };
}

const action: EmailUpdateAction = {
  account: 'me@example.com',
  threadId: 't1',
  messageId: 'm1',
  action: 'removeLabel',
  label: 'watch',
  source: 's',
  reason: 'r',
};

describe('enqueueEmailUpdates', () => {
  it('enqueues each action with one createdAt stamp', () => {
    const client = { enqueue: vi.fn(() => 1) };
    expect(enqueueEmailUpdates(client, [action, action], false)).toBe(STAMP);
    expect(client.enqueue).toHaveBeenCalledTimes(2);
    expect(client.enqueue).toHaveBeenCalledWith(EMAIL_UPDATES_QUEUE, {
      ...action,
      createdAt: STAMP,
    });
  });

  it('enqueues nothing in reportOnly or when there are no actions', () => {
    const client = { enqueue: vi.fn(() => 1) };
    expect(enqueueEmailUpdates(client, [action], true)).toBeNull();
    expect(enqueueEmailUpdates(client, [], false)).toBeNull();
    expect(client.enqueue).not.toHaveBeenCalled();
  });
});

describe('enqueueLabelActions', () => {
  it('enqueues one addLabel per label when not reportOnly', () => {
    const client = { enqueue: vi.fn(() => 1) };
    const r = enqueueLabelActions(client, opts(false));
    expect(client.enqueue).toHaveBeenCalledTimes(2);
    expect(client.enqueue).toHaveBeenCalledWith(EMAIL_UPDATES_QUEUE, {
      account: 'me@example.com',
      messageId: 'm1',
      threadId: 't1',
      action: 'addLabel',
      label: 'Receipts',
      source: 'poll-classification',
      reason: 'test',
      createdAt: STAMP,
    });
    expect(r).toEqual({
      applied: { Receipts: STAMP, 'Bucket/A': STAMP },
      planned: 2,
      enqueued: 2,
    });
  });

  it('enqueues nothing and records nothing in reportOnly', () => {
    const client = { enqueue: vi.fn(() => 1) };
    const r = enqueueLabelActions(client, opts(true));
    expect(client.enqueue).not.toHaveBeenCalled();
    expect(r).toEqual({ applied: {}, planned: 2, enqueued: 0 });
  });

  it('reports nothing planned for an empty label list', () => {
    const client = { enqueue: vi.fn(() => 1) };
    expect(enqueueLabelActions(client, { ...opts(false), labels: [] })).toEqual(
      { applied: {}, planned: 0, enqueued: 0 },
    );
  });
});

describe('curationSignalActions', () => {
  const base = { account: 'me@example.com', threadId: 't1', messageId: 'm1' };

  it('adds watch when a seen message is moved back to the inbox', () => {
    expect(
      curationSignalActions({
        ...base,
        cachedLabels: ['CATEGORY_UPDATES'],
        currentLabels: ['INBOX'],
        seenBefore: true,
      }),
    ).toEqual([
      expect.objectContaining({
        action: 'addLabel',
        label: 'watch',
        messageId: 'm1',
        source: 'poll-curation-signal',
      }),
    ]);
  });

  it('ignores an unseen message arriving in the inbox', () => {
    expect(
      curationSignalActions({
        ...base,
        cachedLabels: [],
        currentLabels: ['INBOX'],
        seenBefore: false,
      }),
    ).toEqual([]);
  });

  it('ignores a message that was already in the inbox', () => {
    expect(
      curationSignalActions({
        ...base,
        cachedLabels: ['INBOX'],
        currentLabels: ['INBOX', 'watch'],
        seenBefore: true,
      }),
    ).toEqual([]);
  });

  it('removes watch when a watched message is archived', () => {
    expect(
      curationSignalActions({
        ...base,
        cachedLabels: ['INBOX', 'watch'],
        currentLabels: ['watch'],
        seenBefore: true,
      }),
    ).toEqual([
      expect.objectContaining({ action: 'removeLabel', label: 'watch' }),
    ]);
  });
});

describe('planDrain', () => {
  it('skips when no Gmail accounts are configured, even in reportOnly', () => {
    expect(planDrain(false, 0, none)).toBe('skip');
    expect(planDrain(true, 0, none)).toBe('skip');
  });

  it('fails visibly when Gmail accounts exist but no credentials, even in reportOnly', () => {
    expect(() => planDrain(false, 1, none)).toThrow(/email\/drain-updates/);
    expect(() => planDrain(true, 3, none)).toThrow(/email\/drain-updates/);
  });

  it('reportOnly applies nothing when credentials exist', () => {
    expect(planDrain(true, 3, sa)).toBe('report-only');
  });

  it('runs with service-account-only credentials', () => {
    expect(planDrain(false, 1, sa)).toBe('run');
  });
});
