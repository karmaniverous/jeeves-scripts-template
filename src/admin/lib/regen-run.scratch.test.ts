/**
 * Orchestration tests for regenerate-token-metrics (lib/regen-run.ts),
 * scratch (--out) mode, with fake adapters.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { args, harness } from './regen-run.fixtures.js';
import { runRegen } from './regen-run.js';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('runRegen (scratch)', () => {
  it('writes only to the scratch dir and never opens runner state', async () => {
    const h = harness();
    expect(await runRegen(args({ out: '/scratch' }), h.deps)).toBe(0);
    expect(h.log).toEqual([
      'scan-oc',
      'scan-cc',
      'names:false',
      'flush:/scratch',
    ]);
    expect(h.deps.openState).not.toHaveBeenCalled();
    expect(h.deps.scanOpenClaw.mock.calls[0][1].countedOnly).toBe(false);
  });

  it.each([
    ['unset', undefined],
    ['invalid', 'not-a-date'],
    ['later than --from', '2026-09-27T00:00:00Z'],
  ])(
    'ignores the upgrade cutoff when it is %s (no --allow-pre-upgrade needed)',
    async (_label, cutoff) => {
      const h = harness();
      h.deps.upgradeCutoff = cutoff;
      expect(
        await runRegen(
          args({ from: '2026-09-20T00:00:00Z', out: '/scratch' }),
          h.deps,
        ),
      ).toBe(0);
      expect(h.log.at(-1)).toBe('flush:/scratch');
      expect(h.deps.openState).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['set', '2026-09-24T09:00:00Z'],
    ['unset', undefined],
  ])(
    'refuses an --out that is the live store (cutoff %s), touching nothing',
    async (_label, cutoff) => {
      const h = harness();
      h.deps.upgradeCutoff = cutoff;
      h.deps.isLiveStore.mockImplementation((dir) => dir === '/live-alias');
      expect(
        await runRegen(
          args({ from: '2026-09-20T00:00:00Z', out: '/live-alias' }),
          h.deps,
        ),
      ).toBe(1);
      expect(console.error).toHaveBeenCalledWith(
        '[regen] --out /live-alias is the live bucket store; scratch runs need a separate directory.',
      );
      expect(h.log).toEqual([]);
      expect(h.deps.openState).not.toHaveBeenCalled();
    },
  );

  it('refuses a scratch dir that already holds buckets in range', async () => {
    const h = harness();
    h.deps.bucketExists.mockReturnValue(true);
    expect(await runRegen(args({ out: '/scratch' }), h.deps)).toBe(1);
    expect(h.deps.scanOpenClaw).not.toHaveBeenCalled();
  });

  it('fails without an agent DB', async () => {
    const h = harness();
    h.deps.agentDbExists = false;
    expect(await runRegen(args(), h.deps)).toBe(1);
  });
});
