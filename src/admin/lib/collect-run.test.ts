/**
 * Orchestration tests for collect-token-metrics (lib/collect-run.ts) with
 * fake adapters. The module graph of the legacy path must not import
 * node:sqlite (absent before Node 22.5): node:sqlite is mocked to throw on
 * import, and the agent-DB collector is only loaded on the DB branch.
 * Also: cursors are saved only after the flush; the unknown-model gate
 * writes nothing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TOKEN_METRICS_CC_CURSOR_KEY,
  TOKEN_METRICS_CURSOR_KEY,
  TOKEN_METRICS_DB_CURSOR_KEY,
} from '../../lib/constants.js';
import type { HourlyBucket } from '../types/token-metrics.js';
import type { CollectDeps } from './collect-run.js';

vi.mock('node:sqlite', () => {
  throw new Error('node:sqlite must not be imported on the legacy path');
});

const MODEL = 'anthropic/claude-opus-5-5';

function harness(useDb: boolean) {
  const log: string[] = [];
  const state = new Map<string, string>([[TOKEN_METRICS_DB_CURSOR_KEY, '{}']]);
  const addUsage = (b: Map<string, HourlyBucket>, seen: Set<string>) => {
    b.set('2026-09-28T10', { hour: '2026-09-28T10', channels: {} });
    seen.add(MODEL);
  };
  const collectOpenClawDb = vi.fn(
    (p: { buckets: Map<string, HourlyBucket>; seenModels: Set<string> }) => {
      log.push('db');
      addUsage(p.buckets, p.seenModels);
      return { 'session:s': { lastSeq: 3, lastTimestamp: 1 } };
    },
  );
  const deps = {
    agentDbPath: '/db',
    sessionsDir: '/sessions',
    useDb,
    cutoffMs: Date.parse('2026-09-28T11:00:00Z'),
    loadOpenClawCollector: vi.fn(() => {
      log.push('load-db');
      return Promise.resolve({ collectOpenClawDb });
    }),
    scanLegacy: vi.fn(() => {
      log.push('legacy');
      const buckets = new Map<string, HourlyBucket>();
      const seenModels = new Set<string>();
      addUsage(buckets, seenModels);
      return {
        buckets,
        seenModels,
        ocProcessed: 1,
        ocSkipped: 0,
        ccProcessed: 0,
        ccSkipped: 0,
      };
    }),
    scanClaudeCode: vi.fn(() => {
      log.push('cc');
      return { ccProcessed: 0, ccSkipped: 0 };
    }),
    ensureRateCard: vi.fn(),
    knownModels: vi.fn((): Record<string, unknown> => ({ [MODEL]: {} })),
    triggerRateCardRefresh: vi.fn(),
    nameDms: vi.fn(() => {
      log.push('names');
      return Promise.resolve();
    }),
    flush: vi.fn((b: Map<string, HourlyBucket>) => {
      log.push('flush');
      return b.size;
    }),
    hasOpenClawBuckets: vi.fn(() => false),
    openState: () => ({
      get: (k: string) => state.get(k) ?? null,
      set: (k: string, v: string) => {
        log.push(`set:${k}`);
        state.set(k, v);
      },
      close: () => undefined,
    }),
  };
  return {
    deps: deps as CollectDeps & typeof deps,
    log,
    state,
    collectOpenClawDb,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('runCollect', () => {
  it('legacy host: never loads the agent-DB collector (no node:sqlite)', async () => {
    const { runCollect } = await import('./collect-run.js');
    const h = harness(false);

    expect(await runCollect(h.deps)).toBe(0);

    expect(h.deps.loadOpenClawCollector).not.toHaveBeenCalled();
    // Sanity: the DB module really does need (the throwing) node:sqlite.
    await expect(import('./openclaw-db/open-agent-db.js')).rejects.toThrow();
    expect(h.log).toEqual([
      'legacy',
      'names',
      'flush',
      `set:${TOKEN_METRICS_CURSOR_KEY}`,
      `set:${TOKEN_METRICS_CC_CURSOR_KEY}`,
    ]);
  });

  it('2026.9 host: loads the DB collector lazily and saves its cursor after the flush', async () => {
    const { runCollect } = await import('./collect-run.js');
    const h = harness(true);

    expect(await runCollect(h.deps)).toBe(0);

    expect(h.log).toEqual([
      'load-db',
      'db',
      'cc',
      'names',
      'flush',
      `set:${TOKEN_METRICS_DB_CURSOR_KEY}`,
      `set:${TOKEN_METRICS_CC_CURSOR_KEY}`,
    ]);
    expect(JSON.parse(h.state.get(TOKEN_METRICS_DB_CURSOR_KEY) ?? '')).toEqual({
      'session:s': { lastSeq: 3, lastTimestamp: 1 },
    });
  });

  it('keeps the DB cursor when the DB collector refuses (no stored cursor)', async () => {
    const { runCollect } = await import('./collect-run.js');
    const h = harness(true);
    h.collectOpenClawDb.mockReturnValue(null as never);

    await runCollect(h.deps);

    expect(h.log).not.toContain(`set:${TOKEN_METRICS_DB_CURSOR_KEY}`);
    expect(h.state.get(TOKEN_METRICS_DB_CURSOR_KEY)).toBe('{}');
  });

  it('refuses to write anything when a model is not on the rate card', async () => {
    const { runCollect } = await import('./collect-run.js');
    const h = harness(true);
    h.deps.knownModels.mockReturnValue({});

    expect(await runCollect(h.deps)).toBe(1);

    expect(h.deps.triggerRateCardRefresh).toHaveBeenCalled();
    expect(h.deps.flush).not.toHaveBeenCalled();
    expect(h.log.filter((l) => l.startsWith('set:'))).toEqual([]);
  });
});
