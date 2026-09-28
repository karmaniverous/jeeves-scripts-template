import { describe, expect, it } from 'vitest';

import {
  formatSlackContext,
  parseWorkerPosts,
  slackOutputInstructions,
} from './worker-posts.js';

const OPS = 'channel:C0B2Z734KSP';
const SAM = 'user:U09JC3DPCS1';
const block = (json: string, fence = '```') =>
  `Agenda written to j:/veterancrowd/ops/ceo/agenda.md.\n\n${fence}slack-posts\n${json}\n${fence}\n`;

describe('parseWorkerPosts', () => {
  it('parses posts and normalizes targets', () => {
    const text = block(
      JSON.stringify([
        { channel: 'C0B2Z734KSP', text: 'Agenda for today', pin: true },
        { channel: SAM, thread_ts: '1790595302.365459', text: 'FYI' },
      ]),
    );
    expect(parseWorkerPosts(text, [OPS, SAM])).toEqual([
      { channel: OPS, text: 'Agenda for today', pin: true },
      { channel: SAM, thread_ts: '1790595302.365459', text: 'FYI' },
    ]);
  });

  it('accepts an empty array and a single object', () => {
    expect(parseWorkerPosts(block('[]'), [OPS])).toEqual([]);
    expect(
      parseWorkerPosts(block('{"channel":"C0B2Z734KSP","text":"x"}'), [OPS]),
    ).toEqual([{ channel: OPS, text: 'x' }]);
  });

  it('accepts edit_ts', () => {
    expect(
      parseWorkerPosts(
        block('[{"channel":"C0B2Z734KSP","text":"v2","edit_ts":"1789.1"}]'),
        [OPS],
      ),
    ).toEqual([{ channel: OPS, text: 'v2', edit_ts: '1789.1' }]);
  });

  it('accepts tilde fences', () => {
    expect(parseWorkerPosts(block('[]', '~~~~'), [OPS])).toEqual([]);
  });

  it.each([
    ['no block', 'I could not post: no Slack tool.', /no `slack-posts` block/],
    [
      'plain json fence',
      block('[]').replace('slack-posts', 'json'),
      /no `slack-posts`/,
    ],
    ['two blocks', block('[]') + block('[]'), /more than one/],
    ['bad JSON', block('[{channel: C1}]'), /not valid JSON/],
    ['empty text', block('[{"channel":"C0B2Z734KSP","text":"  "}]'), /Invalid/],
    [
      'unknown key',
      block('[{"channel":"C0B2Z734KSP","text":"x","as_user":true}]'),
      /Invalid/,
    ],
    [
      'bad thread_ts',
      block('[{"channel":"C0B2Z734KSP","text":"x","thread_ts":"yesterday"}]'),
      /Invalid/,
    ],
    [
      'edit with pin',
      block(
        '[{"channel":"C0B2Z734KSP","text":"x","edit_ts":"1.2","pin":true}]',
      ),
      /edit_ts cannot be combined/,
    ],
    [
      'disallowed target',
      block('[{"channel":"C0OTHER1234","text":"x"}]'),
      /not an allowed target/,
    ],
    [
      'channel name',
      block('[{"channel":"#ops-ceo","text":"x"}]'),
      /not an allowed target/,
    ],
  ])('rejects %s', (_name, text, error) => {
    expect(() => parseWorkerPosts(text, [OPS])).toThrow(error);
  });

  it('rejects a null reply', () => {
    expect(() => parseWorkerPosts(null, [OPS])).toThrow(/no `slack-posts`/);
  });
});

describe('slackOutputInstructions', () => {
  it('forbids Slack tools and lists allowed targets', () => {
    const text = slackOutputInstructions([
      { target: OPS, purpose: 'the agenda (pin it)' },
    ]);
    expect(text).toMatch(/do not call the message tool or any Slack tool/);
    expect(text).toContain('```slack-posts');
    expect(text).toContain(`- ${OPS}: the agenda (pin it)`);
  });

  it('says there are no targets when none are allowed', () => {
    expect(slackOutputInstructions([])).toMatch(/does not post to Slack/);
  });
});

describe('formatSlackContext', () => {
  it('formats reads with timestamps, ts and thread ts', () => {
    const text = formatSlackContext([
      {
        label: '#ops-ceo [channel:C0B2Z734KSP]',
        messages: [
          { ts: '1790590000.000100', user: 'U1', text: 'line 1\nline 2' },
          {
            ts: '1790595400.000001',
            text: 'reply',
            threadTs: '1790590000.000100',
          },
        ],
      },
      { label: 'empty', messages: [] },
    ]);
    expect(text).toContain('## Slack context');
    expect(text).toContain(
      '[2026-09-28 10:06 UTC] ts=1790590000.000100 U1: line 1\n    line 2',
    );
    expect(text).toContain('thread_ts=1790590000.000100 unknown: reply');
    expect(text).toContain('### empty (oldest first)\n(no messages)');
  });

  it('is empty without reads', () => {
    expect(formatSlackContext([])).toBe('');
  });
});
