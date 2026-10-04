/**
 * Orchestration tests for regenerate-token-metrics (lib/regen-run.ts) with
 * fake adapters: live rebuild order (backup → delete → flush → cursor
 * replace), bounded --to rebuilds (counted-only, cursors untouched),
 * dry-run non-mutation, backup failure aborting before deletion, the
 * unknown-model gate and scratch mode.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TOKEN_METRICS_CC_CURSOR_KEY,
  TOKEN_METRICS_DB_CURSOR_KEY,
} from '../../lib/constants.js';
import type { HourlyBucket } from '../types/token-metrics.js';
import { type RegenArgs, type RegenDeps, runRegen } from './regen-run.js';

const CUTOFF = Date.parse('2026-09-28T12:00:00Z');
const FROM = '2026-09-24T09:00:00Z';
const FROM_MS = Date.parse(FROM);

const args = (over: Partial<RegenArgs> = {}): RegenArgs => ({
  from: FROM,
  to: '',
  out: '',
  dryRun: false,
  allowPreUpgrade: false,
  ...over,
});

function harness(stored: Record<string, string> = {}) {
  const log: string[] = [];
  const state = new Map(Object.entries(stored));
  const bucket = (b: Map<string, HourlyBucket>) => {
    b.set('2026-09-24T09', { hour: '2026-09-24T09', channels: {} });
  };
  const deps = {
    agentDbPath: '/db',
    agentDbExists: true,
    cutoffMs: CUTOFF,
    upgradeCutoff: FROM as string | undefined,
    scanOpenClaw: vi.fn(
      (
        cursors: Record<string, unknown>,
        o: { countedOnly?: boolean },
        b: Map<string, HourlyBucket>,
        seen: Set<string>,
      ) => {
        log.push('scan-oc');
        bucket(b);
        seen.add('anthropic/claude-opus-5-5');
        if (!o.countedOnly)
          cursors['session:new'] = { lastSeq: 9, lastTimestamp: 1 };
        return Promise.resolve({
          schemaVersion: 23,
          transcriptsProcessed: 1,
          usageCounted: 1,
        });
      },
    ),
    scanClaudeCode: vi.fn(
      (
        _f: number,
        _t: number,
        cursors: Record<string, unknown>,
        _b: unknown,
        _s: unknown,
        o: { countedOnly?: boolean },
      ) => {
        log.push('scan-cc');
        if (!o.countedOnly)
          cursors['cc:file'] = { byteOffset: 999, lastTimestamp: 2 };
        return { ccProcessed: 1 };
      },
    ),
    knownModels: (): Record<string, unknown> => ({
      'anthropic/claude-opus-5-5': {},
    }),
    bucketExists: vi.fn(() => false),
    backup: vi.fn((_h: string[], dry: boolean) => {
      log.push(`backup:${String(dry)}`);
      return 3;
    }),
    remove: vi.fn((_h: string[], dry: boolean) => {
      log.push(`remove:${String(dry)}`);
      return 3;
    }),
    flush: vi.fn((b: Map<string, HourlyBucket>, dir?: string) => {
      log.push(`flush:${dir ?? 'live'}`);
      return b.size;
    }),
    nameDms: vi.fn((_b: unknown, dry: boolean) => {
      log.push(`names:${String(dry)}`);
      return Promise.resolve();
    }),
    openState: vi.fn(() => ({
      get: (k: string) => state.get(k) ?? null,
      set: (k: string, v: string) => {
        log.push(`set:${k}`);
        state.set(k, v);
      },
      close: () => {
        log.push('close');
      },
    })),
  };
  return { deps: deps as unknown as RegenDeps & typeof deps, log, state };
}

const DB_CURSOR = JSON.stringify({
  'session:a': { lastSeq: 4, lastTimestamp: 0 },
});
const CC_CURSOR = JSON.stringify({
  'cc:file': { byteOffset: 50, lastTimestamp: FROM_MS + 1 },
  'cc:old': { byteOffset: 10, lastTimestamp: FROM_MS - 1 },
});

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
