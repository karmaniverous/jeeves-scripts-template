/**
 * Shared fixtures for the regen-run tests: CLI args and a harness of fake
 * adapters that logs the order of scans, backups, deletes, flushes and
 * runner-state writes.
 */

import { vi } from 'vitest';

import type { HourlyBucket } from '../types/token-metrics.js';
import type { RegenArgs, RegenDeps } from './regen-run.js';

export const CUTOFF = Date.parse('2026-09-28T12:00:00Z');
export const FROM = '2026-09-24T09:00:00Z';
export const FROM_MS = Date.parse(FROM);

export const args = (over: Partial<RegenArgs> = {}): RegenArgs => ({
  from: FROM,
  to: '',
  out: '',
  dryRun: false,
  allowPreUpgrade: false,
  ...over,
});

export function harness(stored: Record<string, string> = {}) {
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
    isLiveStore: vi.fn<(dir: string) => boolean>(() => false),
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

export const DB_CURSOR = JSON.stringify({
  'session:a': { lastSeq: 4, lastTimestamp: 0 },
});
export const CC_CURSOR = JSON.stringify({
  'cc:file': { byteOffset: 50, lastTimestamp: FROM_MS + 1 },
  'cc:old': { byteOffset: 10, lastTimestamp: FROM_MS - 1 },
});
