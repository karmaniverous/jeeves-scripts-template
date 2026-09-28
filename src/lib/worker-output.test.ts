import { describe, expect, it, vi } from 'vitest';

import {
  extractFinalAssistantText,
  findWorkerSessionKey,
  readWorkerFinalText,
} from './worker-output.js';

const KEY = 'agent:main:subagent:3b1f0c2e-1111-4222-8333-944455556666';
const STDOUT = [
  '[2026-09-28T05:37:00.000Z] Spawning worker for job refresh-',
  '[2026-09-28T05:39:10.000Z] Worker completed successfully',
  `WORKER_RESULT:${JSON.stringify({ sessionKey: KEY, tokens: 1234, durationMs: 130000 })}`,
  '',
].join('\n');

/** Messages shaped like OpenClaw 2026.9 sessions_history output. */
const MESSAGES = [
  { role: 'user', content: [{ type: 'text', text: 'task' }] },
  {
    role: 'assistant',
    stopReason: 'toolUse',
    content: [
      { type: 'text', text: 'Fetching pricing…' },
      { type: 'toolCall', id: 't1', name: 'web_fetch', arguments: {} },
    ],
  },
  {
    role: 'toolResult',
    toolCallId: 't1',
    content: [{ type: 'text', text: '…' }],
  },
  {
    role: 'assistant',
    stopReason: 'stop',
    content: [
      { type: 'text', text: 'All rates verified.' },
      { type: 'text', text: 'RESULT: unchanged' },
    ],
  },
  { role: 'custom', customType: 'openclaw.nested-tool.v1', content: [] },
];

describe('findWorkerSessionKey', () => {
  it('finds the key in the WORKER_RESULT line', () => {
    expect(findWorkerSessionKey(STDOUT)).toBe(KEY);
  });

  it('returns null without a WORKER_RESULT line', () => {
    expect(findWorkerSessionKey('Worker failed: boom\n')).toBeNull();
  });
});

describe('extractFinalAssistantText', () => {
  it('joins the text parts of the last assistant message', () => {
    expect(extractFinalAssistantText(MESSAGES)).toBe(
      'All rates verified.\nRESULT: unchanged',
    );
  });

  it('accepts string content', () => {
    expect(
      extractFinalAssistantText([{ role: 'assistant', content: 'hi' }]),
    ).toBe('hi');
  });

  it('skips assistant messages without text', () => {
    expect(
      extractFinalAssistantText([
        { role: 'assistant', content: 'earlier' },
        { role: 'assistant', content: [{ type: 'toolCall', id: 'x' }] },
      ]),
    ).toBe('earlier');
  });

  it.each([[undefined], [[]], [[{ role: 'user', content: 'x' }]]])(
    'returns null for %j',
    (messages) => {
      expect(extractFinalAssistantText(messages)).toBeNull();
    },
  );
});

describe('readWorkerFinalText', () => {
  it('reads the final reply via sessions_history (details shape)', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue({ details: { messages: MESSAGES } });
    await expect(readWorkerFinalText(STDOUT, invoke)).resolves.toMatch(
      /RESULT: unchanged$/,
    );
    expect(invoke).toHaveBeenCalledWith('sessions_history', {
      sessionKey: KEY,
      limit: 20,
      includeTools: false,
    });
  });

  it('accepts the flat { messages } shape', async () => {
    const invoke = vi.fn().mockResolvedValue({ messages: MESSAGES });
    await expect(readWorkerFinalText(STDOUT, invoke)).resolves.toMatch(
      /^All rates verified/,
    );
  });

  it('returns null without calling the gateway when there is no key', async () => {
    const invoke = vi.fn();
    await expect(readWorkerFinalText('nothing', invoke)).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('propagates gateway failures', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('gateway down'));
    await expect(readWorkerFinalText(STDOUT, invoke)).rejects.toThrow(
      'gateway down',
    );
  });
});
