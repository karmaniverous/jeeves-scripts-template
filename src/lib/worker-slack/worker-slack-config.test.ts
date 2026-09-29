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

  it.each([
    ['bare id then channel: prefix', 'C0B2Z734KSP', 'channel:C0B2Z734KSP'],
    ['channel: prefix then bare id', 'channel:C0B2Z734KSP', 'c0b2z734ksp'],
    ['bare user id then user: prefix', 'U0ABCDEFGH', 'user:U0ABCDEFGH'],
  ])('rejects duplicate post targets (%s)', (_name, first, second) => {
    const config = {
      posts: [
        { target: first, purpose: 'a', editTs: ['1789.1'] },
        { target: second, purpose: 'b', pin: true },
      ],
    };
    expect(() => parseWorkerSlackConfig(config)).toThrow(
      /Duplicate post target (channel|user):[A-Z0-9]+ \("/,
    );
  });

  it('accepts distinct post targets', () => {
    const config = {
      posts: [
        { target: 'C0B2Z734KSP', purpose: 'a' },
        { target: 'channel:C0B2Z734KSQ', purpose: 'b' },
        { target: 'user:U0ABCDEFGH', purpose: 'c' },
      ],
    };
    expect(parseWorkerSlackConfig(config)).toEqual(config);
  });
});
