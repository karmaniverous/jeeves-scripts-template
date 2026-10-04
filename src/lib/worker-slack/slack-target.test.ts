import { describe, expect, it } from 'vitest';

import { normalizeSlackTarget, requireSlackTarget } from './slack-target.js';

describe('normalizeSlackTarget', () => {
  it.each([
    ['C000EXAMPLE1', 'channel:C000EXAMPLE1'],
    ['c000example1', 'channel:C000EXAMPLE1'],
    ['G0ABCDEF12', 'channel:G0ABCDEF12'],
    ['D000EXAMPLE1', 'channel:D000EXAMPLE1'],
    ['U000EXAMPLE3', 'user:U000EXAMPLE3'],
    ['W0ABCDEF12', 'user:W0ABCDEF12'],
    ['channel:C000EXAMPLE1', 'channel:C000EXAMPLE1'],
    [' user:u000example3 ', 'user:U000EXAMPLE3'],
  ])('%j → %j', (raw, target) => {
    expect(normalizeSlackTarget(raw)).toBe(target);
  });

  it.each([
    '#ops-ceo',
    'ops-ceo',
    '',
    'C1',
    'email:x@y.z',
    'channel:U000EXAMPLE3',
    'channel:W0ABCDEF12',
    'user:C000EXAMPLE1',
    'user:D000EXAMPLE1',
    'channel:C1',
  ])('rejects %j', (raw) => {
    expect(normalizeSlackTarget(raw)).toBeNull();
  });

  it('requireSlackTarget throws on names and prefix/ID-family mismatches', () => {
    expect(() => requireSlackTarget('#ops-ceo')).toThrow(
      /Invalid Slack target/,
    );
    expect(() => requireSlackTarget('user:C000EXAMPLE1')).toThrow(
      /Invalid Slack target/,
    );
  });
});
