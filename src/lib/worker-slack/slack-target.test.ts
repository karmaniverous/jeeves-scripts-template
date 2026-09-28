import { describe, expect, it } from 'vitest';

import { normalizeSlackTarget, requireSlackTarget } from './slack-target.js';

describe('normalizeSlackTarget', () => {
  it.each([
    ['C0B2Z734KSP', 'channel:C0B2Z734KSP'],
    ['c0b2z734ksp', 'channel:C0B2Z734KSP'],
    ['G0ABCDEF12', 'channel:G0ABCDEF12'],
    ['D0AMFV5SGN8', 'channel:D0AMFV5SGN8'],
    ['U09JC3DPCS1', 'user:U09JC3DPCS1'],
    ['W0ABCDEF12', 'user:W0ABCDEF12'],
    ['channel:C0B2Z734KSP', 'channel:C0B2Z734KSP'],
    [' user:u09jc3dpcs1 ', 'user:U09JC3DPCS1'],
  ])('%j → %j', (raw, target) => {
    expect(normalizeSlackTarget(raw)).toBe(target);
  });

  it.each(['#ops-ceo', 'ops-ceo', '', 'C1', 'email:x@y.z'])(
    'rejects %j',
    (raw) => {
      expect(normalizeSlackTarget(raw)).toBeNull();
    },
  );

  it('requireSlackTarget throws on names', () => {
    expect(() => requireSlackTarget('#ops-ceo')).toThrow(
      /Invalid Slack target/,
    );
  });
});
