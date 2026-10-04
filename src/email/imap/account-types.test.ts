import { describe, expect, it } from 'vitest';

import { getAccountType } from './account-types.js';
import type { NormalizedMessage } from './normalize.js';

// ── Fixture ──────────────────────────────────────────────────────────

function makeMsg(
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage {
  return {
    uid: 1,
    flags: [],
    headers: {
      'message-id': '<test@example.com>',
      references: '',
      'in-reply-to': '',
      from: 'a@example.com',
      to: 'c@example.org',
      cc: '',
      subject: 'Test',
      date: 'Mon, 1 Jan 2024 00:00:00 +0000',
    },
    extensions: {},
    internalDate: new Date('2024-01-01T00:00:00Z'),
    body: { text: '', html: '' },
    attachments: [],
    computed: { threadRoot: '<test@example.com>', snippet: '' },
    ...overrides,
  };
}

// ── Gmail label normalization ────────────────────────────────────────

describe('gmail labels', () => {
  const gmail = getAccountType('gmail');

  it('maps \\Inbox to INBOX', () => {
    const msg = makeMsg({
      extensions: { 'x-gm-labels': ['\\Inbox'] },
      flags: ['\\Seen'],
    });
    expect(gmail.labels(msg)).toContain('INBOX');
  });

  it('maps multiple system labels', () => {
    const msg = makeMsg({
      extensions: { 'x-gm-labels': ['\\Inbox', '\\Sent', '\\Starred'] },
      flags: ['\\Seen'],
    });
    const labels = gmail.labels(msg);
    expect(labels).toEqual(
      expect.arrayContaining(['INBOX', 'SENT', 'STARRED']),
    );
  });

  it('derives UNREAD from absence of \\Seen flag', () => {
    const msg = makeMsg({
      extensions: { 'x-gm-labels': ['\\Inbox'] },
      flags: [],
    });
    expect(gmail.labels(msg)).toContain('UNREAD');
  });

  it('does not add UNREAD when \\Seen is present', () => {
    const msg = makeMsg({
      extensions: { 'x-gm-labels': ['\\Inbox'] },
      flags: ['\\Seen'],
    });
    expect(gmail.labels(msg)).not.toContain('UNREAD');
  });

  it('uppercases unknown labels as fallback', () => {
    const msg = makeMsg({
      extensions: { 'x-gm-labels': ['my-custom-label'] },
      flags: ['\\Seen'],
    });
    expect(gmail.labels(msg)).toContain('MY-CUSTOM-LABEL');
  });

  it('returns empty array when x-gm-labels is absent', () => {
    const msg = makeMsg({ extensions: {}, flags: ['\\Seen'] });
    expect(gmail.labels(msg)).toEqual([]);
  });

  it('maps \\Spam and \\Trash correctly', () => {
    const msg = makeMsg({
      extensions: { 'x-gm-labels': ['\\Spam', '\\Trash'] },
      flags: ['\\Seen'],
    });
    const labels = gmail.labels(msg);
    expect(labels).toContain('SPAM');
    expect(labels).toContain('TRASH');
  });
});

// ── Generic IMAP flag normalization ──────────────────────────────────

describe('imap labels', () => {
  const imap = getAccountType('imap');

  it('derives UNREAD from absence of \\Seen', () => {
    const msg = makeMsg({ flags: [] });
    expect(imap.labels(msg)).toContain('UNREAD');
  });

  it('does not add UNREAD when \\Seen is present', () => {
    const msg = makeMsg({ flags: ['\\Seen'] });
    expect(imap.labels(msg)).not.toContain('UNREAD');
  });

  it('maps \\Flagged to STARRED', () => {
    const msg = makeMsg({ flags: ['\\Seen', '\\Flagged'] });
    expect(imap.labels(msg)).toContain('STARRED');
  });

  it('maps \\Draft to DRAFT', () => {
    const msg = makeMsg({ flags: ['\\Seen', '\\Draft'] });
    expect(imap.labels(msg)).toContain('DRAFT');
  });

  it('maps \\Deleted to TRASH', () => {
    const msg = makeMsg({ flags: ['\\Seen', '\\Deleted'] });
    expect(imap.labels(msg)).toContain('TRASH');
  });

  it('maps \\Answered to ANSWERED', () => {
    const msg = makeMsg({ flags: ['\\Seen', '\\Answered'] });
    expect(imap.labels(msg)).toContain('ANSWERED');
  });

  it('ignores \\Recent', () => {
    const msg = makeMsg({ flags: ['\\Seen', '\\Recent'] });
    const labels = imap.labels(msg);
    expect(labels).not.toContain('RECENT');
    expect(labels).not.toContain('\\Recent');
  });

  it('strips $ prefix on custom flags and uppercases', () => {
    const msg = makeMsg({ flags: ['\\Seen', '$Forwarded'] });
    expect(imap.labels(msg)).toContain('FORWARDED');
  });

  it('handles multiple flags together', () => {
    const msg = makeMsg({ flags: ['\\Flagged', '\\Answered', '$Forwarded'] });
    const labels = imap.labels(msg);
    expect(labels).toEqual(
      expect.arrayContaining(['UNREAD', 'STARRED', 'ANSWERED', 'FORWARDED']),
    );
  });
});

// ── Registry ─────────────────────────────────────────────────────────

describe('getAccountType', () => {
  it('throws for unknown type', () => {
    expect(() => getAccountType('outlook')).toThrow(
      'Unknown IMAP account type: "outlook"',
    );
  });
});
