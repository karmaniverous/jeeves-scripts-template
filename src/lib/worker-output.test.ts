import { describe, expect, it, vi } from 'vitest';

import {
  extractFinalAssistantText,
  findWorkerSessionKey,
  HISTORY_MAX_CHARS,
  readWorkerFinalText,
} from './worker-output.js';
import { parseWorkerPosts } from './worker-slack/worker-posts.js';

const KEY = 'agent:main:subagent:3b1f0c2e-1111-4222-8333-944455556666';
const STDOUT = [
  '[2026-09-28T05:37:00.000Z] Spawning worker for job refresh-',
  '[2026-09-28T05:39:10.000Z] Worker completed successfully',
  `WORKER_RESULT:${JSON.stringify({ sessionKey: KEY, tokens: 1234, durationMs: 130000 })}`,
  '',
].join('\n');

/** Messages shaped like OpenClaw 2026.9 chat.history output. */
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
      { type: 'thinking', thinking: 'drafting' },
      { type: 'text', text: 'All rates verified.' },
      { type: 'text', text: 'RESULT: unchanged' },
    ],
    __openclaw: { id: 'm4', seq: 4 },
  },
  { role: 'custom', customType: 'openclaw.nested-tool.v1', content: [] },
];

/** A worker-slack reply longer than the old 4000-char sessions_history cap. */
const LONG_REPLY = [
  `Summary: ${'agenda line. '.repeat(400)}`,
  '```slack-posts',
  JSON.stringify([{ channel: 'channel:C0B2Z734KSP', text: 'x'.repeat(3000) }]),
  '```',
].join('\n');

function historyWith(message: Record<string, unknown>) {
  return { messages: [MESSAGES[0], message] };
}

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
  it('reads the final reply via chat.history with the max per-message cap', async () => {
    const rpc = vi.fn().mockResolvedValue({ messages: MESSAGES });
    await expect(readWorkerFinalText(STDOUT, rpc)).resolves.toBe(
      'All rates verified.\nRESULT: unchanged',
    );
    expect(rpc).toHaveBeenCalledWith('chat.history', {
      sessionKey: KEY,
      limit: 20,
      maxChars: HISTORY_MAX_CHARS,
    });
    expect(HISTORY_MAX_CHARS).toBe(500_000);
  });

  it('returns a long reply whole, closing fence included', async () => {
    expect(LONG_REPLY.length).toBeGreaterThan(8000);
    const rpc = vi.fn().mockResolvedValue(
      historyWith({
        role: 'assistant',
        content: [{ type: 'text', text: LONG_REPLY }],
        __openclaw: { id: 'm2', seq: 2 },
      }),
    );
    const text = await readWorkerFinalText(STDOUT, rpc);
    expect(text).toBe(LONG_REPLY);
    expect(text?.endsWith('```')).toBe(true);
    const allowed = [{ target: 'C0B2Z734KSP', purpose: 'agenda' }];
    expect(parseWorkerPosts(text, allowed)).toEqual([
      { channel: 'channel:C0B2Z734KSP', text: 'x'.repeat(3000) },
    ]);
    // What the 4000-char sessions_history cap used to hand the parser:
    expect(() => parseWorkerPosts(LONG_REPLY.slice(0, 4000), allowed)).toThrow(
      'no `slack-posts` block',
    );
  });

  it('fails loudly when the gateway still truncated the reply', async () => {
    const rpc = vi.fn().mockResolvedValue(
      historyWith({
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: `${LONG_REPLY.slice(0, 4000)}\n...(truncated)...`,
          },
        ],
        __openclaw: { id: 'm2', truncated: true, reason: 'display-cap' },
      }),
    );
    await expect(readWorkerFinalText(STDOUT, rpc)).rejects.toThrow(
      `worker reply truncated by gateway (session ${KEY}: display-cap)`,
    );
  });

  it('fails loudly when the reply was omitted as too large', async () => {
    const rpc = vi.fn().mockResolvedValue(
      historyWith({
        role: 'assistant',
        content: [
          { type: 'text', text: '[chat.history omitted: message too large]' },
        ],
      }),
    );
    await expect(readWorkerFinalText(STDOUT, rpc)).rejects.toThrow(
      /worker reply truncated by gateway .*message too large/,
    );
  });

  it('reports a truncation flag without a reason', async () => {
    const rpc = vi.fn().mockResolvedValue(
      historyWith({
        role: 'assistant',
        content: 'cut',
        __openclaw: { truncated: true },
      }),
    );
    await expect(readWorkerFinalText(STDOUT, rpc)).rejects.toThrow(
      /worker reply truncated by gateway .*: truncated\)/,
    );
  });

  it.each([[{}], [null], [{ messages: [] }]])(
    'returns null when history %j has no assistant text',
    async (result) => {
      const rpc = vi.fn().mockResolvedValue(result);
      await expect(readWorkerFinalText(STDOUT, rpc)).resolves.toBeNull();
    },
  );

  it('returns null without calling the gateway when there is no key', async () => {
    const rpc = vi.fn();
    await expect(readWorkerFinalText('nothing', rpc)).resolves.toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('propagates gateway failures', async () => {
    const rpc = vi.fn().mockRejectedValue(new Error('gateway down'));
    await expect(readWorkerFinalText(STDOUT, rpc)).rejects.toThrow(
      'gateway down',
    );
  });
});
