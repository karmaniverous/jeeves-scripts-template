import { describe, expect, it, vi } from 'vitest';

vi.mock('@karmaniverous/jeeves', () => ({
  nowIso: () => '2026-10-04T00:00:00.000Z',
}));

import {
  EMAIL_UPDATES_QUEUE,
  enqueueLabelActions,
  planDrain,
} from './label-actions.js';

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

describe('enqueueLabelActions', () => {
  it('enqueues one addLabel per label when not reportOnly', () => {
    const client = { enqueue: vi.fn() };
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
      createdAt: '2026-10-04T00:00:00.000Z',
    });
    expect(r).toEqual({
      applied: {
        Receipts: '2026-10-04T00:00:00.000Z',
        'Bucket/A': '2026-10-04T00:00:00.000Z',
      },
      planned: 2,
      enqueued: 2,
    });
  });

  it('enqueues nothing and records nothing in reportOnly', () => {
    const client = { enqueue: vi.fn() };
    const r = enqueueLabelActions(client, opts(true));
    expect(client.enqueue).not.toHaveBeenCalled();
    expect(r).toEqual({ applied: {}, planned: 2, enqueued: 0 });
  });
});

describe('planDrain', () => {
  it('reportOnly wins over everything, even missing credentials', () => {
    expect(planDrain(true, 3, none)).toBe('report-only');
    expect(planDrain(true, 3, sa)).toBe('report-only');
  });

  it('skips when no Gmail accounts are configured', () => {
    expect(planDrain(false, 0, none)).toBe('skip');
  });

  it('runs with service-account-only credentials', () => {
    expect(planDrain(false, 1, sa)).toBe('run');
  });

  it('fails visibly when Gmail accounts exist but no credentials', () => {
    expect(() => planDrain(false, 1, none)).toThrow(/email\/drain-updates/);
  });
});
