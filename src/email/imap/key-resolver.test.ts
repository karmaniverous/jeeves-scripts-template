import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { autoTransform, resolveKey } from './key-resolver.js';
import type { NormalizedMessage } from './normalize.js';

// ── Minimal NormalizedMessage fixture ────────────────────────────────

function makeMsg(
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage {
  return {
    uid: 1,
    flags: [],
    headers: {
      'message-id': '<test-msg-id@example.com>',
      references: '',
      'in-reply-to': '',
      from: 'Alice <alice@example.com>',
      to: 'Bob <bob@example.com>',
      cc: '',
      subject: 'Test',
      date: 'Mon, 1 Jan 2024 00:00:00 +0000',
    },
    extensions: {
      'x-gm-thrid': '1854665568266641192',
      'x-gm-msgid': '1854665568266641999',
    },
    internalDate: new Date('2024-01-01T00:00:00Z'),
    body: { text: 'Hello world', html: '' },
    attachments: [],
    computed: {
      threadRoot: '<root-msg-id@example.com>',
      snippet: 'Hello world',
    },
    ...overrides,
  };
}

// ── autoTransform ─────────────────────────────────────────────────────

describe('autoTransform', () => {
  it('converts a decimal integer string to lowercase hex', () => {
    const result = autoTransform('1854665568266641192');
    expect(result).toBe(BigInt('1854665568266641192').toString(16));
    expect(/^[0-9a-f]+$/.test(result)).toBe(true);
  });

  it('converts a large decimal integer to hex without precision loss', () => {
    const bigDecimal = '18446744073709551615'; // 2^64 - 1
    const result = autoTransform(bigDecimal);
    expect(result).toBe('ffffffffffffffff');
  });

  it('converts a non-decimal string to sha256-16', () => {
    const input = '<test@msg.com>';
    const expected = createHash('sha256')
      .update(input)
      .digest('hex')
      .slice(0, 16);
    const result = autoTransform(input);
    expect(result).toBe(expected);
    expect(result).toHaveLength(16);
  });

  it('produces different hashes for different inputs', () => {
    const r1 = autoTransform('<msg1@example.com>');
    const r2 = autoTransform('<msg2@example.com>');
    expect(r1).not.toBe(r2);
  });

  it('returns hex only (no uppercase chars) for sha256 path', () => {
    const result = autoTransform('<something@test.org>');
    expect(/^[0-9a-f]{16}$/.test(result)).toBe(true);
  });
});

// ── resolveKey ────────────────────────────────────────────────────────

describe('resolveKey', () => {
  it('resolves a single path and transforms decimal to hex', () => {
    const msg = makeMsg();
    const result = resolveKey(['$.extensions.x-gm-thrid'], msg);
    expect(result).toBe(BigInt('1854665568266641192').toString(16));
  });

  it('resolves a single path and applies sha256-16 for non-decimal', () => {
    const msg = makeMsg();
    const result = resolveKey(['$.computed.threadRoot'], msg);
    const expected = createHash('sha256')
      .update('<root-msg-id@example.com>')
      .digest('hex')
      .slice(0, 16);
    expect(result).toBe(expected);
  });

  it('resolves a single path to message-id header', () => {
    const msg = makeMsg();
    const result = resolveKey(['$.headers.message-id'], msg);
    const expected = createHash('sha256')
      .update('<test-msg-id@example.com>')
      .digest('hex')
      .slice(0, 16);
    expect(result).toBe(expected);
  });

  it('concatenates multiple paths before transforming', () => {
    const msg = makeMsg({
      extensions: { 'x-gm-thrid': '100', 'x-gm-msgid': '200' },
    });
    // Concatenated: '100' + '200' = '100200' (decimal) → hex
    const expected = BigInt('100200').toString(16);
    const result = resolveKey(
      ['$.extensions.x-gm-thrid', '$.extensions.x-gm-msgid'],
      msg,
    );
    expect(result).toBe(expected);
  });

  it('throws when a path resolves to nothing', () => {
    const msg = makeMsg();
    expect(() => resolveKey(['$.nonexistent.field'], msg)).toThrow(
      'resolved to nothing',
    );
  });

  it('uses the first match when a path matches multiple values', () => {
    const msg = makeMsg({
      extensions: { 'x-gm-thrid': '255', 'x-gm-msgid': '256' },
    });
    // Wildcard yields ['255', '256']; only the first match is used.
    const result = resolveKey(['$.extensions.*'], msg);
    expect(result).toBe('ff');
  });

  it('stringifies a numeric match', () => {
    const msg = makeMsg({ uid: 4096 });
    expect(resolveKey(['$.uid'], msg)).toBe('1000');
  });

  it('keeps an array-valued match wrapped and rejects it', () => {
    const msg = makeMsg({ flags: ['\\Seen'] });
    // With wrap: true the array value arrives as a single match, not spread.
    expect(() => resolveKey(['$.flags'], msg)).toThrow(
      'non-stringifiable value',
    );
  });

  it('throws when a path resolves to an object', () => {
    const msg = makeMsg();
    expect(() => resolveKey(['$.body'], msg)).toThrow(
      'non-stringifiable value',
    );
  });
});
