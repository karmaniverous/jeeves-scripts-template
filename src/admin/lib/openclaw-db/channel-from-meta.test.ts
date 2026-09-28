import { describe, expect, it } from 'vitest';

import {
  channelFromMeta,
  cleanPart,
  resolveChannel,
  sanitizeChannel,
} from './channel-from-meta.js';
import {
  runtimeContext,
  sessionHeader,
  userMessage,
} from './real-events-v23.js';
import type { SessionMeta } from './types.js';

const DM_HEAD = [
  sessionHeader('s1'),
  userMessage('Can you check the build?'),
  runtimeContext('Jason Williscroft'),
];

describe('channelFromMeta', () => {
  it.each<[string, SessionMeta, string]>([
    [
      'Slack channel with a recorded name',
      {
        sessionKey: 'agent:main:slack:channel:c0aujrk8dtm',
        channelName: '#ops-ceo',
      },
      'slack:channel:#ops-ceo',
    ],
    [
      'Slack thread session (same channel)',
      {
        sessionKey:
          'agent:main:slack:channel:c0aujrk8dtm:thread:1790362838.368049',
        channelName: '#ops-ceo',
      },
      'slack:channel:#ops-ceo',
    ],
    [
      'Slack channel without a name (upper-case id, as pre-upgrade)',
      { sessionKey: 'agent:main:slack:channel:c0aujrk8dtm' },
      'slack:channel:C0AUJRK8DTM',
    ],
    [
      'Slack DM with the origin label',
      {
        sessionKey: 'agent:main:slack:direct:u0ab7j9rchf',
        peerName: 'Jason Williscroft',
      },
      'slack:dm:jason-williscroft',
    ],
    [
      'Slack DM without a name',
      { sessionKey: 'agent:main:slack:direct:u0ab7j9rchf:thread:1.2' },
      'slack:dm:U0AB7J9RCHF',
    ],
    [
      'labelled subagent',
      {
        sessionKey: 'agent:main:subagent:7e326f56',
        label: 'worker-vc-ops-t',
      },
      'subagent:label:worker-vc-ops-t',
    ],
    [
      'subagent label with trailing punctuation',
      {
        sessionKey: 'agent:main:subagent:7e326f56',
        label: 'fix D:\\repos\\karmaniverous\\jeeves-tools.',
      },
      'subagent:label:fix D:\\repos\\karmaniverous\\jeeves-tools',
    ],
    [
      'meta phase subagent',
      { sessionKey: 'agent:main:subagent:1', label: 'meta-architect' },
      'meta-architect',
    ],
    [
      'unlabelled subagent spawned from a Slack channel (rolled up)',
      {
        sessionKey: 'agent:main:subagent:1',
        parent: {
          sessionKey: 'agent:main:slack:channel:c0aujrk8dtm',
          channelName: '#ops-ceo',
        },
      },
      'slack:channel:#ops-ceo',
    ],
    [
      'cron job',
      {
        sessionKey: 'agent:main:cron:bf9f173f',
        label: 'Cron: Memory Dreaming Promotion',
      },
      'cron:Memory Dreaming Promotion',
    ],
    [
      'Telegram group',
      {
        sessionKey: 'agent:main:telegram:group:-1001640142674',
        channelName: 'The Rabbit Hole',
      },
      'telegram:group:The Rabbit Hole',
    ],
  ])('%s', (_name, meta, key) => {
    expect(channelFromMeta(meta)?.key).toBe(key);
  });

  it.each<[string, SessionMeta]>([
    ['main session', { sessionKey: 'agent:main:main' }],
    ['recovered session', { sessionKey: 'agent:main:recovered:abc' }],
    ['unlabelled orphan subagent', { sessionKey: 'agent:main:subagent:1' }],
    ['malformed key', { sessionKey: 'nonsense' }],
  ])('returns null for %s (text rules decide)', (_name, meta) => {
    expect(channelFromMeta(meta)).toBeNull();
  });
});

describe('resolveChannel', () => {
  it('prefers metadata over runtime-context transcript text', () => {
    const meta: SessionMeta = {
      sessionKey: 'agent:main:slack:direct:u0ab7j9rchf',
      peerName: 'Jason Williscroft',
    };
    expect(resolveChannel(meta, DM_HEAD)).toEqual({
      key: 'slack:dm:jason-williscroft',
      name: 'DM: Jason Williscroft',
    });
  });

  it('falls back to text rules without absorbing injected runtime context', () => {
    const { key } = resolveChannel(undefined, DM_HEAD);
    expect(key).toBe('slack:dm:jason-williscroft');
    expect(key).not.toMatch(/approved|executables/);
  });

  it('still reads the pre-upgrade inline DM form', () => {
    expect(
      resolveChannel(undefined, [
        userMessage('System: Slack DM from Bob Louthan: status?'),
      ]).key,
    ).toBe('slack:dm:bob-louthan');
  });

  it('strips trailing punctuation from text-rule keys', () => {
    const head = [
      sessionHeader('s2'),
      userMessage(
        '[Subagent Task] Fix the build in D:\\repos\\karmaniverous\\jeeves-tools.',
      ),
    ];
    expect(resolveChannel(undefined, head).key).toBe(
      'subagent:repo:karmaniverous/jeeves-tools',
    );
  });

  it('uses text rules when metadata does not identify the channel', () => {
    const head = [
      userMessage(
        'Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.',
      ),
    ];
    expect(resolveChannel({ sessionKey: 'agent:main:main' }, head).key).toBe(
      'heartbeat',
    );
  });
});

describe('sanitizeChannel / cleanPart', () => {
  it.each([
    ['subagent:repo:acme/widget.', 'subagent:repo:acme/widget'],
    ['subagent:task:Do it!?', 'subagent:task:Do it'],
    ['subagent:label:a\n  b ', 'subagent:label:a b'],
    [
      'subagent:task:Daily 1-1 (Sam / Bob)',
      'subagent:task:Daily 1-1 (Sam / Bob)',
    ],
  ])('cleans %j', (raw, clean) => {
    expect(cleanPart(raw)).toBe(clean);
  });

  it('never returns an empty key', () => {
    expect(sanitizeChannel({ key: '...', name: '' })).toEqual({
      key: 'unknown',
      name: 'Unknown',
    });
  });
});
