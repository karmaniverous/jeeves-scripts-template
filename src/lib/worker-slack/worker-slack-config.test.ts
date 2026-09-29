import { describe, expect, it } from 'vitest';

import { parseWorkerSlackConfig } from './worker-slack-config.js';

const VALID = {
  accountId: 'vc',
  reads: [
    { target: 'C0B2Z734KSP', label: '#ops-ceo', limit: 50 },
    { target: 'channel:D0ABCDEFGH', label: 'DM', threadTs: '1790.1' },
  ],
  posts: [
    {
      target: 'C0B2Z734KSP',
      purpose: 'the agenda',
      editTs: ['1789000000.000100'],
      pin: false,
    },
  ],
};

describe('parseWorkerSlackConfig', () => {
  it('accepts a valid config unchanged', () => {
    expect(parseWorkerSlackConfig(VALID)).toEqual(VALID);
  });

  it('accepts an empty config', () => {
    expect(parseWorkerSlackConfig({})).toEqual({});
  });

  it.each([
    ['a non-object', 'nope'],
    ['an unknown key', { ...VALID, extra: 1 }],
    ['an account id with spaces', { accountId: 'v c' }],
    ['an empty account id', { accountId: '' }],
    ['a channel-name read', { reads: [{ target: '#ops', label: 'ops' }] }],
    ['an empty label', { reads: [{ target: 'C0B2Z734KSP', label: ' ' }] }],
    [
      'a negative limit',
      { reads: [{ target: 'C0B2Z734KSP', label: 'x', limit: -1 }] },
    ],
    [
      'a fractional limit',
      { reads: [{ target: 'C0B2Z734KSP', label: 'x', limit: 2.5 }] },
    ],
    [
      'a huge limit',
      { reads: [{ target: 'C0B2Z734KSP', label: 'x', limit: 1000 }] },
    ],
    [
      'a bad thread ts',
      { reads: [{ target: 'C0B2Z734KSP', label: 'x', threadTs: 'today' }] },
    ],
    ['an empty purpose', { posts: [{ target: 'C0B2Z734KSP', purpose: '' }] }],
    [
      'a user post target typo',
      { posts: [{ target: 'user:C1', purpose: 'p' }] },
    ],
    [
      'a bad edit ts',
      { posts: [{ target: 'C0B2Z734KSP', purpose: 'p', editTs: ['latest'] }] },
    ],
    [
      'an unknown post key',
      { posts: [{ target: 'C0B2Z734KSP', purpose: 'p', as_user: true }] },
    ],
  ])('rejects %s', (_name, config) => {
    expect(() => parseWorkerSlackConfig(config)).toThrow(
      /Invalid worker-slack config/,
    );
  });
});
