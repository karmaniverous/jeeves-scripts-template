/**
 * Orchestration tests for regenerate-token-metrics (lib/regen-run.ts), live
 * mode, with fake adapters: rebuild order (backup → delete → flush → cursor
 * replace), bounded --to rebuilds (counted-only, cursors untouched),
 * dry-run non-mutation, backup failure aborting before deletion, the
 * unknown-model gate and the upgrade-cutoff guard.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TOKEN_METRICS_CC_CURSOR_KEY,
  TOKEN_METRICS_DB_CURSOR_KEY,
} from '../../lib/constants.js';
import {
  args,
  CC_CURSOR,
  CUTOFF,
  DB_CURSOR,
  FROM_MS,
  harness,
} from './regen-run.fixtures.js';
import { runRegen } from './regen-run.js';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('runRegen (live)', () => {
  it('backs up, deletes, flushes, then replaces the DB and CC cursors', async () => {
    const h = harness({
      [TOKEN_METRICS_DB_CURSOR_KEY]: DB_CURSOR,
      [TOKEN_METRICS_CC_CURSOR_KEY]: CC_CURSOR,
    });

    expect(await runRegen(args(), h.deps)).toBe(0);

    expect(h.log).toEqual([
      'scan-oc',
      'scan-cc',
      'names:false',
      'backup:false',
      'remove:false',
      'flush:live',
      `set:${TOKEN_METRICS_DB_CURSOR_KEY}`,
      `set:${TOKEN_METRICS_CC_CURSOR_KEY}`,
      'close',
    ]);
    const hours = h.deps.backup.mock.calls[0][0];
    expect(hours[0]).toBe('2026-09-24T09');
    expect(hours.at(-1)).toBe('2026-09-28T11');
    expect(h.deps.scanOpenClaw.mock.calls[0][1]).toEqual({
      fromMs: FROM_MS,
      toMs: CUTOFF,
      countedOnly: false,
    });
    // Fresh scan from seq 0: the stored DB cursor is replaced, not extended.
    expect(JSON.parse(h.state.get(TOKEN_METRICS_DB_CURSOR_KEY) ?? '')).toEqual({
      'session:new': { lastSeq: 9, lastTimestamp: 1 },
    });
    expect(JSON.parse(h.state.get(TOKEN_METRICS_CC_CURSOR_KEY) ?? '')).toEqual({
      'cc:file': { byteOffset: 999, lastTimestamp: 2 },
      'cc:old': { byteOffset: 10, lastTimestamp: FROM_MS - 1 },
    });
  });

  it('with --to rebuilds counted-only and leaves every cursor as stored', async () => {
    const h = harness({
      [TOKEN_METRICS_DB_CURSOR_KEY]: DB_CURSOR,
      [TOKEN_METRICS_CC_CURSOR_KEY]: CC_CURSOR,
    });

    expect(await runRegen(args({ to: '2026-09-25T00:00:00Z' }), h.deps)).toBe(
      0,
    );

    const toMs = Date.parse('2026-09-25T00:00:00Z');
    expect(h.deps.scanOpenClaw.mock.calls[0][1]).toEqual({
      fromMs: FROM_MS,
      toMs,
      countedOnly: true,
    });
    expect(h.deps.scanOpenClaw.mock.calls[0][0]).toEqual(JSON.parse(DB_CURSOR));
    expect(h.deps.scanClaudeCode.mock.calls[0][2]).toEqual(
      JSON.parse(CC_CURSOR),
    );
    expect(h.deps.scanClaudeCode.mock.calls[0][5]).toEqual({
      countedOnly: true,
    });
    expect(h.deps.backup.mock.calls[0][0].at(-1)).toBe('2026-09-24T23');
    expect(h.log).toContain('flush:live');
    expect(h.log.filter((l) => l.startsWith('set:'))).toEqual([]);
    expect(h.state.get(TOKEN_METRICS_CC_CURSOR_KEY)).toBe(CC_CURSOR);
  });

  it('refuses --to before the DB cursor is bootstrapped', async () => {
    const h = harness();
    expect(await runRegen(args({ to: '2026-09-25T00:00:00Z' }), h.deps)).toBe(
      1,
    );
    expect(h.deps.scanOpenClaw).not.toHaveBeenCalled();
    expect(h.deps.backup).not.toHaveBeenCalled();
  });

  it('dry run scans and reports but mutates nothing', async () => {
    const h = harness({ [TOKEN_METRICS_DB_CURSOR_KEY]: DB_CURSOR });
    expect(await runRegen(args({ dryRun: true }), h.deps)).toBe(0);
    expect(h.log).toEqual([
      'scan-oc',
      'scan-cc',
      'names:true',
      'backup:true',
      'remove:true',
      'close',
    ]);
    expect(h.state.get(TOKEN_METRICS_DB_CURSOR_KEY)).toBe(DB_CURSOR);
  });

  it('a backup failure aborts before any bucket is deleted', async () => {
    const h = harness();
    h.deps.backup.mockImplementation(() => {
      throw new Error('EPERM');
    });
    await expect(runRegen(args(), h.deps)).rejects.toThrow('EPERM');
    expect(h.deps.remove).not.toHaveBeenCalled();
    expect(h.deps.flush).not.toHaveBeenCalled();
    expect(h.log).toContain('close');
  });

  it('refuses unknown models before touching buckets or state', async () => {
    const h = harness();
    h.deps.knownModels = () => ({});
    expect(await runRegen(args(), h.deps)).toBe(1);
    expect(h.deps.backup).not.toHaveBeenCalled();
    expect(h.log.filter((l) => l.startsWith('set:'))).toEqual([]);
  });

  it('refuses a pre-upgrade --from unless allowed', async () => {
    const h = harness();
    expect(await runRegen(args({ from: '2026-09-20T00:00:00Z' }), h.deps)).toBe(
      1,
    );
    expect(h.deps.scanOpenClaw).not.toHaveBeenCalled();

    expect(
      await runRegen(
        args({ from: '2026-09-20T00:00:00Z', allowPreUpgrade: true }),
        h.deps,
      ),
    ).toBe(0);
    expect(h.deps.scanOpenClaw).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unset', undefined],
    ['invalid', 'not-a-date'],
  ])(
    'refuses when OPENCLAW_UPGRADE_CUTOFF is %s, even dry or with --allow-pre-upgrade',
    async (_label, cutoff) => {
      const h = harness();
      h.deps.upgradeCutoff = cutoff;
      for (const over of [{}, { dryRun: true }, { allowPreUpgrade: true }]) {
        expect(await runRegen(args(over), h.deps)).toBe(1);
      }
      expect(console.error).toHaveBeenCalledWith(
        expect.stringMatching(/OPENCLAW_UPGRADE_CUTOFF/),
      );
      expect(h.deps.openState).not.toHaveBeenCalled();
      expect(h.deps.scanOpenClaw).not.toHaveBeenCalled();
    },
  );
});
