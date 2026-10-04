import { describe, expect, it } from 'vitest';

import { parseWorkerSlackConfig } from './worker-slack-config.js';

const VALID = {
  accountId: 'acct-b',
  reads: [
    { target: 'C000EXAMPLE1', label: '#ops-ceo', limit: 50 },
    { target: 'channel:D0ABCDEFGH', label: 'DM', threadTs: '1790.1' },
  ],
  posts: [
    {
      target: 'C000EXAMPLE1',
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
    ['an empty label', { reads: [{ target: 'C000EXAMPLE1', label: ' ' }] }],
    [
      'a negative limit',
      { reads: [{ target: 'C000EXAMPLE1', label: 'x', limit: -1 }] },
    ],
    [
      'a fractional limit',
      { reads: [{ target: 'C000EXAMPLE1', label: 'x', limit: 2.5 }] },
    ],
    [
      'a huge limit',
      { reads: [{ target: 'C000EXAMPLE1', label: 'x', limit: 1000 }] },
    ],
    [
      'a bad thread ts',
      { reads: [{ target: 'C000EXAMPLE1', label: 'x', threadTs: 'today' }] },
    ],
    ['an empty purpose', { posts: [{ target: 'C000EXAMPLE1', purpose: '' }] }],
    [
      'a user post target typo',
      { posts: [{ target: 'user:C1', purpose: 'p' }] },
    ],
    [
      'a bad edit ts',
      { posts: [{ target: 'C000EXAMPLE1', purpose: 'p', editTs: ['latest'] }] },
    ],
    [
      'an unknown post key',
      { posts: [{ target: 'C000EXAMPLE1', purpose: 'p', as_user: true }] },
    ],
  ])('rejects %s', (_name, config) => {
    expect(() => parseWorkerSlackConfig(config)).toThrow(
      /Invalid worker-slack config/,
    );
  });

  it.each([
    [
      'bare id then channel: prefix',
      'C000EXAMPLE1',
      'channel:C000EXAMPLE1',
      'channel:C000EXAMPLE1',
    ],
    [
      'channel: prefix then bare id',
      'channel:C000EXAMPLE1',
      'c000example1',
      'channel:C000EXAMPLE1',
    ],
    [
      'bare user id then user: prefix',
      'U0ABCDEFGH',
      'user:U0ABCDEFGH',
      'user:U0ABCDEFGH',
    ],
  ])(
    'rejects duplicate post targets (%s)',
    (_name, first, second, normalized) => {
      const config = {
        posts: [
          { target: first, purpose: 'a', editTs: ['1789.1'] },
          { target: second, purpose: 'b', pin: true },
        ],
      };
      expect(() => parseWorkerSlackConfig(config)).toThrow(
        new Error(
          'Invalid worker-slack config: ' +
            `✖ Duplicate post target ${normalized} ("${second}")\n` +
            '  → at posts[1].target',
        ),
      );
    },
  );

  it('flags only the later duplicate, at its own index', () => {
    const config = {
      posts: [
        { target: 'C000EXAMPLE1', purpose: 'a' },
        { target: 'user:U0ABCDEFGH', purpose: 'b' },
        { target: ' channel:c000example1 ', purpose: 'c' },
      ],
    };
    expect(() => parseWorkerSlackConfig(config)).toThrow(
      new Error(
        'Invalid worker-slack config: ' +
          '✖ Duplicate post target channel:C000EXAMPLE1 (" channel:c000example1 ")\n' +
          '  → at posts[2].target',
      ),
    );
  });

  it('accepts distinct post targets', () => {
    const config = {
      posts: [
        { target: 'C000EXAMPLE1', purpose: 'a' },
        { target: 'channel:C000EXAMPLE3', purpose: 'b' },
        { target: 'user:U0ABCDEFGH', purpose: 'c' },
      ],
    };
    expect(parseWorkerSlackConfig(config)).toEqual(config);
  });
});
