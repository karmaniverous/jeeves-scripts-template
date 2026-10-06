import { describe, expect, it, vi } from 'vitest';

vi.mock('@karmaniverous/jeeves', () => ({
  nowIso: () => '2026-10-04T00:00:00.000Z',
}));

import { EMAIL_UPDATES_QUEUE } from '../../email/google-workspace/label-actions.js';
import {
  enqueueMeetingEmailActions,
  MEETING_ACTION_SOURCE,
  meetingEmailActions,
} from './email-actions.js';

const STAMP = '2026-10-04T00:00:00.000Z';

function ref(labels: string[]) {
  return {
    account: 'me@example.com',
    threadId: 't1',
    messageId: 'm1',
    labels,
  };
}

const base = {
  account: 'me@example.com',
  threadId: 't1',
  messageId: 'm1',
  source: MEETING_ACTION_SOURCE,
};

describe('meetingEmailActions', () => {
  it('labels an archived message without archiving it again', () => {
    expect(meetingEmailActions(ref(['meeting-ish']))).toEqual([
      {
        ...base,
        action: 'addLabel',
        label: 'meeting',
        reason: 'Meeting package created from this message',
      },
    ]);
  });

  it('labels and archives an inbox message', () => {
    expect(meetingEmailActions(ref(['INBOX'])).map((a) => a.action)).toEqual([
      'addLabel',
      'archive',
    ]);
  });

  it('never archives a watched inbox message', () => {
    expect(
      meetingEmailActions(ref(['INBOX', 'watch'])).map((a) => a.action),
    ).toEqual(['addLabel']);
  });
});

describe('enqueueMeetingEmailActions', () => {
  it('enqueues every action on email-updates when not reportOnly', () => {
    const client = { enqueue: vi.fn(() => 1) };
    expect(enqueueMeetingEmailActions(client, ref(['INBOX']), false)).toBe(2);
    expect(client.enqueue).toHaveBeenCalledTimes(2);
    expect(client.enqueue).toHaveBeenNthCalledWith(2, EMAIL_UPDATES_QUEUE, {
      ...base,
      action: 'archive',
      reason: 'Meeting email archived after packaging',
      createdAt: STAMP,
    });
  });

  it('enqueues nothing in reportOnly', () => {
    const client = { enqueue: vi.fn(() => 1) };
    expect(enqueueMeetingEmailActions(client, ref(['INBOX']), true)).toBe(0);
    expect(client.enqueue).not.toHaveBeenCalled();
  });
});

describe('meetingEmailActions with archive off', () => {
  it('labels an inbox message without archiving it', () => {
    expect(
      meetingEmailActions(ref(['INBOX']), { archive: false }).map(
        (a) => a.action,
      ),
    ).toEqual(['addLabel']);
  });

  it('archives by default when the option is omitted', () => {
    expect(
      meetingEmailActions(ref(['INBOX']), {}).map((a) => a.action),
    ).toEqual(['addLabel', 'archive']);
  });

  it('enqueues only the label when archive is off', () => {
    const client = { enqueue: vi.fn(() => 1) };
    expect(
      enqueueMeetingEmailActions(client, ref(['INBOX']), false, {
        archive: false,
      }),
    ).toBe(1);
    expect(client.enqueue).toHaveBeenCalledTimes(1);
    expect(client.enqueue).toHaveBeenCalledWith(
      EMAIL_UPDATES_QUEUE,
      expect.objectContaining({ action: 'addLabel', label: 'meeting' }),
    );
  });
});
