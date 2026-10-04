import { describe, expect, it } from 'vitest';

import { messageRecord, messageSummary } from './message-record.js';

const IDS = { account: 'me@example.com', threadId: 't1', messageId: 'm1' };
const AT = '2026-10-04T00:00:00.000Z';

const message = {
  id: 'm1',
  snippet: 'Hello there',
  internalDate: '1790000000000',
  labelIds: ['INBOX', 'UNREAD'],
  payload: {
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'Subject', value: 'Hi' },
      { name: 'From', value: 'a@example.com' },
      { name: 'To', value: 'me@example.com' },
      { name: 'Cc', value: 'c@example.com' },
      { name: 'Date', value: 'Sun, 4 Oct 2026 00:00:00 +0000' },
    ],
    parts: [
      {
        mimeType: 'text/plain',
        body: { data: Buffer.from('Body text').toString('base64url') },
      },
      {
        mimeType: 'application/pdf',
        filename: 'invoice.pdf',
        body: { attachmentId: 'att1', size: 1234 },
      },
    ],
  },
};

describe('messageRecord', () => {
  it('builds the on-disk record and counts attachments', () => {
    const r = messageRecord(IDS, message, AT);
    expect(r.attachmentCount).toBe(1);
    expect(r.record).toEqual({
      messageId: 'm1',
      threadId: 't1',
      account: 'me@example.com',
      subject: 'Hi',
      from: 'a@example.com',
      to: 'me@example.com',
      cc: 'c@example.com',
      date: 'Sun, 4 Oct 2026 00:00:00 +0000',
      internalDateMs: 1790000000000,
      labels: ['INBOX', 'UNREAD'],
      body: { text: 'Body text', html: '' },
      attachments: [
        { filename: 'invoice.pdf', mimeType: 'application/pdf', size: 1234 },
      ],
      downloadedAt: AT,
    });
  });

  it('tolerates a message without payload, date or labels', () => {
    const r = messageRecord(IDS, { id: 'm1' }, AT);
    expect(r.attachmentCount).toBe(0);
    expect(r.record).toMatchObject({
      subject: '',
      internalDateMs: null,
      labels: [],
      body: { text: '', html: '' },
      attachments: [],
    });
  });
});

describe('messageSummary', () => {
  it('keeps id, snippet and Date header', () => {
    expect(messageSummary('m1', message)).toEqual({
      id: 'm1',
      snippet: 'Hello there',
      date: 'Sun, 4 Oct 2026 00:00:00 +0000',
    });
    expect(messageSummary('m2', {})).toEqual({
      id: 'm2',
      snippet: '',
      date: '',
    });
  });
});
