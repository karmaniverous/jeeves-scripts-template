import type { FetchMessageObject } from 'imapflow';
import type { ParsedMail } from 'mailparser';
import { describe, expect, it } from 'vitest';

import { generateSnippet, normalizeMessage } from './normalize.js';

// ── Fixtures ──────────────────────────────────────────────────────────

function makeFetch(
  overrides: Partial<FetchMessageObject> = {},
): FetchMessageObject {
  return {
    seq: 1,
    uid: 42,
    flags: new Set(['\\Seen']),
    internalDate: new Date('2024-06-01T12:00:00Z'),
    ...overrides,
  };
}

function makeMail(overrides: Partial<ParsedMail> = {}): ParsedMail {
  return {
    headers: new Map(),
    headerLines: [
      { key: 'date', line: 'Date: Sat, 1 Jun 2024 12:00:00 +0000' },
    ],
    attachments: [],
    html: false,
    subject: 'Test Subject',
    messageId: '<abc123@example.com>',
    from: { text: 'Alice <alice@example.com>', html: '', value: [] },
    to: { text: 'Bob <bob@example.com>', html: '', value: [] },
    cc: undefined,
    ...overrides,
  };
}

// ── generateSnippet ───────────────────────────────────────────────────

describe('generateSnippet', () => {
  it('returns empty string for undefined input', () => {
    expect(generateSnippet(undefined)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(generateSnippet('')).toBe('');
  });

  it('collapses consecutive whitespace into single spaces', () => {
    const result = generateSnippet('Hello   World\n\tFoo   Bar');
    expect(result).toBe('Hello World Foo Bar');
  });

  it('trims leading and trailing whitespace', () => {
    const result = generateSnippet('  Hello World  ');
    expect(result).toBe('Hello World');
  });

  it('truncates to 200 characters', () => {
    const long = 'A'.repeat(300);
    const result = generateSnippet(long);
    expect(result).toHaveLength(200);
  });

  it('does not truncate text under 200 chars', () => {
    const short = 'Hello World';
    expect(generateSnippet(short)).toBe('Hello World');
  });
});

// ── computeThreadRoot (via normalizeMessage) ──────────────────────────

describe('normalizeMessage — threadRoot', () => {
  it('uses first Message-ID from References header', () => {
    const mail = makeMail({
      references: ['<ref1@mail.test>', '<ref2@mail.test>'],
    });
    const msg = normalizeMessage(makeFetch(), mail);
    expect(msg.computed.threadRoot).toBe('<ref1@mail.test>');
  });

  it('uses own messageId when References is absent', () => {
    const mail = makeMail({ references: undefined });
    const msg = normalizeMessage(makeFetch(), mail);
    expect(msg.computed.threadRoot).toBe('<abc123@example.com>');
  });

  it('uses own messageId when References is empty string', () => {
    const mail = makeMail({ references: '' });
    const msg = normalizeMessage(makeFetch(), mail);
    expect(msg.computed.threadRoot).toBe('<abc123@example.com>');
  });

  it('handles single string References', () => {
    const mail = makeMail({ references: '<single@ref.example>' });
    const msg = normalizeMessage(makeFetch(), mail);
    expect(msg.computed.threadRoot).toBe('<single@ref.example>');
  });

  it('handles whitespace-separated References string', () => {
    const mail = makeMail({
      references: '<first@ref.example> <second@ref.example>',
    });
    const msg = normalizeMessage(makeFetch(), mail);
    expect(msg.computed.threadRoot).toBe('<first@ref.example>');
  });
});

// ── Gmail extension mapping ───────────────────────────────────────────

describe('normalizeMessage — Gmail extensions', () => {
  it('maps threadId to x-gm-thrid', () => {
    const fetch = makeFetch({ threadId: '1854665568266641192' });
    const msg = normalizeMessage(fetch, makeMail());
    expect(msg.extensions['x-gm-thrid']).toBe('1854665568266641192');
  });

  it('maps emailId to x-gm-msgid', () => {
    const fetch = makeFetch({ emailId: '1854665568266641999' });
    const msg = normalizeMessage(fetch, makeMail());
    expect(msg.extensions['x-gm-msgid']).toBe('1854665568266641999');
  });

  it('maps labels Set to x-gm-labels array', () => {
    const fetch = makeFetch({
      labels: new Set(['INBOX', 'UNREAD', 'CATEGORY_UPDATES']),
    });
    const msg = normalizeMessage(fetch, makeMail());
    expect(Array.isArray(msg.extensions['x-gm-labels'])).toBe(true);
    const labels = msg.extensions['x-gm-labels'] as string[];
    expect(labels).toContain('INBOX');
    expect(labels).toContain('UNREAD');
  });

  it('omits x-gm-thrid when threadId is absent', () => {
    const fetch = makeFetch({ threadId: undefined });
    const msg = normalizeMessage(fetch, makeMail());
    expect(msg.extensions['x-gm-thrid']).toBeUndefined();
  });
});

// ── Flags extraction ──────────────────────────────────────────────────

describe('normalizeMessage — flags', () => {
  it('converts flags Set to string array', () => {
    const fetch = makeFetch({ flags: new Set(['\\Seen', '\\Flagged']) });
    const msg = normalizeMessage(fetch, makeMail());
    expect(msg.flags).toEqual(['\\Seen', '\\Flagged']);
  });

  it('returns empty array when flags are absent', () => {
    const fetch = makeFetch({
      flags: undefined as unknown as Set<string>,
    });
    const msg = normalizeMessage(fetch, makeMail());
    expect(msg.flags).toEqual([]);
  });
});

// ── Attachments ───────────────────────────────────────────────────────

describe('normalizeMessage — attachments', () => {
  it('extracts non-related attachments', () => {
    const mail = makeMail({
      attachments: [
        {
          filename: 'doc.pdf',
          contentType: 'application/pdf',
          size: 1024,
          related: false,
          type: 'attachment',
          content: Buffer.from(''),
          contentDisposition: 'attachment',
          headers: new Map(),
          headerLines: [],
          checksum: '',
        },
      ] as ParsedMail['attachments'],
    });
    const msg = normalizeMessage(makeFetch(), mail);
    expect(msg.attachments).toEqual([
      { filename: 'doc.pdf', mimeType: 'application/pdf', size: 1024 },
    ]);
  });

  it('filters out related (inline) attachments', () => {
    const mail = makeMail({
      attachments: [
        {
          filename: 'inline.png',
          contentType: 'image/png',
          size: 512,
          related: true,
          type: 'attachment',
          content: Buffer.from(''),
          contentDisposition: 'inline',
          headers: new Map(),
          headerLines: [],
          checksum: '',
        },
      ] as ParsedMail['attachments'],
    });
    const msg = normalizeMessage(makeFetch(), mail);
    expect(msg.attachments).toEqual([]);
  });
});

// ── Body extraction ───────────────────────────────────────────────────

describe('normalizeMessage — body', () => {
  it('extracts text and HTML body', () => {
    const mail = makeMail({ text: 'Plain text', html: '<p>HTML</p>' });
    const msg = normalizeMessage(makeFetch(), mail);
    expect(msg.body.text).toBe('Plain text');
    expect(msg.body.html).toBe('<p>HTML</p>');
  });

  it('returns empty html when mail.html is false', () => {
    const mail = makeMail({ html: false });
    const msg = normalizeMessage(makeFetch(), mail);
    expect(msg.body.html).toBe('');
  });

  it('returns empty text when text is undefined', () => {
    const mail = makeMail({ text: undefined });
    const msg = normalizeMessage(makeFetch(), mail);
    expect(msg.body.text).toBe('');
  });
});

// ── Snippet generation (via normalizeMessage) ─────────────────────────

describe('normalizeMessage — snippet', () => {
  it('generates snippet from text body', () => {
    const mail = makeMail({ text: 'Hello World this is a test' });
    const msg = normalizeMessage(makeFetch(), mail);
    expect(msg.computed.snippet).toBe('Hello World this is a test');
  });

  it('snippet is empty when no text body', () => {
    const mail = makeMail({ text: undefined });
    const msg = normalizeMessage(makeFetch(), mail);
    expect(msg.computed.snippet).toBe('');
  });
});
