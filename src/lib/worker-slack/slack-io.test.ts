import { describe, expect, it, vi } from 'vitest';

import {
  assertOk,
  gatewaySlackIo,
  parseMessages,
  sentMessageId,
} from './slack-io.js';

/** Result shaped like the 2026.9 gateway message tool (/tools/invoke). */
const toolResult = (payload: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  details: { status: 'ok' },
});

const READ = toolResult({
  ok: true,
  channelId: 'C0B2Z734KSP',
  messages: [
    { user: 'U2', type: 'message', ts: '1790595302.365459', text: 'newer' },
    {
      user: 'U1',
      type: 'message',
      ts: '1790590000.000100',
      text: 'older',
      thread_ts: '1790590000.000100',
      blocks: [],
    },
    {
      type: 'message',
      ts: '1790595400.000001',
      text: 'reply',
      thread_ts: '1790590000.000100',
    },
    { type: 'message', ts: '1790595500.000002', bot_id: 'B1' },
  ],
});

describe('parseMessages', () => {
  it('parses 2026.9 read results oldest first', () => {
    expect(parseMessages(READ)).toEqual([
      { ts: '1790590000.000100', user: 'U1', text: 'older' },
      { ts: '1790595302.365459', user: 'U2', text: 'newer' },
      { ts: '1790595400.000001', text: 'reply', threadTs: '1790590000.000100' },
      { ts: '1790595500.000002', text: '' },
    ]);
  });

  it('returns [] only for a valid empty channel', () => {
    expect(parseMessages(toolResult({ ok: true, messages: [] }))).toEqual([]);
  });

  it('accepts messages in details', () => {
    expect(
      parseMessages({ details: { messages: [{ ts: '1.1', text: 'x' }] } }),
    ).toEqual([{ ts: '1.1', text: 'x' }]);
  });

  it.each([
    ['null', null],
    ['non-JSON text', { content: [{ type: 'text', text: 'not json' }] }],
    ['ok without messages', toolResult({ ok: true, channelId: 'C1' })],
    ['renamed field', toolResult({ ok: true, items: [] })],
  ])('throws when the messages field is missing (%s)', (_name, result) => {
    expect(() => parseMessages(result)).toThrow(/no `messages` field/);
  });

  it.each([
    ['an object', { ts: '1.1' }],
    ['a string', 'hello'],
    ['null', null],
    ['a message without ts', [{ text: 'x' }]],
    ['a numeric ts', [{ ts: 1.1, text: 'x' }]],
    ['a non-object message', ['x']],
  ])('throws when messages is %s', (_name, messages) => {
    expect(() => parseMessages(toolResult({ ok: true, messages }))).toThrow(
      /invalid `messages` shape/,
    );
  });
});

describe('sentMessageId / assertOk', () => {
  it.each([
    [toolResult({ ok: true, messageId: '1790.1' }), '1790.1'],
    [toolResult({ ok: true, ts: '1790.2', channel: 'C1' }), '1790.2'],
    [toolResult({ ok: true, result: { messageId: '1790.3' } }), '1790.3'],
    [{ details: { message_id: '1790.4' } }, '1790.4'],
    [toolResult({ ok: true }), undefined],
  ])('finds the posted ts in %j', (result, id) => {
    expect(sentMessageId(result)).toBe(id);
  });

  it('throws on ok:false', () => {
    expect(() =>
      assertOk('send', toolResult({ ok: false, error: 'not_in_channel' })),
    ).toThrow('Slack send failed: not_in_channel');
  });
});

describe('gatewaySlackIo', () => {
  it('reads through the message tool', async () => {
    const invoke = vi.fn().mockResolvedValue(READ);
    const io = gatewaySlackIo(invoke);
    await expect(
      io.read('channel:C0B2Z734KSP', {
        limit: 5,
        threadTs: '1790590000.000100',
      }),
    ).resolves.toHaveLength(4);
    expect(invoke).toHaveBeenCalledWith('message', {
      action: 'read',
      channel: 'slack',
      target: 'channel:C0B2Z734KSP',
      limit: 5,
      threadId: '1790590000.000100',
    });
  });

  it('sends and pins through the message tool', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(toolResult({ ok: true, messageId: '1790.9' }))
      .mockResolvedValueOnce(toolResult({ ok: true }));
    const io = gatewaySlackIo(invoke);

    await expect(io.send('channel:C1ABCDEFG', 'hello')).resolves.toBe('1790.9');
    await io.pin('channel:C1ABCDEFG', '1790.9');

    expect(invoke).toHaveBeenNthCalledWith(1, 'message', {
      action: 'send',
      channel: 'slack',
      target: 'channel:C1ABCDEFG',
      message: 'hello',
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'message', {
      action: 'pin',
      channel: 'slack',
      target: 'channel:C1ABCDEFG',
      messageId: '1790.9',
    });
  });

  it('fails a read whose response has no messages array', async () => {
    const invoke = vi.fn().mockResolvedValue(toolResult({ ok: true }));
    await expect(
      gatewaySlackIo(invoke).read('channel:C0B2Z734KSP'),
    ).rejects.toThrow(/no `messages` field/);
  });

  it('passes the account id on every call and edits', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(toolResult({ ok: true, messages: [] }))
      .mockResolvedValue(toolResult({ ok: true }));
    const io = gatewaySlackIo(invoke, 'vc');
    await io.read('channel:C0B2Z734KSP');
    await io.edit('channel:C0B2Z734KSP', '1789.1', 'v2');
    expect(invoke).toHaveBeenNthCalledWith(1, 'message', {
      action: 'read',
      channel: 'slack',
      accountId: 'vc',
      target: 'channel:C0B2Z734KSP',
      limit: 20,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'message', {
      action: 'edit',
      channel: 'slack',
      accountId: 'vc',
      target: 'channel:C0B2Z734KSP',
      messageId: '1789.1',
      message: 'v2',
    });
  });

  it('passes thread replies as threadId', async () => {
    const invoke = vi.fn().mockResolvedValue(toolResult({ ok: true }));
    await gatewaySlackIo(invoke).send('user:U1ABCDEFG', 'hi', '1790.5');
    expect(invoke).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({ threadId: '1790.5' }),
    );
  });
});
