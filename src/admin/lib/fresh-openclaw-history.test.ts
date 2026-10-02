/**
 * collect-token-metrics with no stored OpenClaw DB cursor, end to end
 * through runCollect, the real DB collector (v23 fixture DB), the real
 * bucket store (temp dir) and in-memory runner state:
 * - fresh instance (nothing counted yet): starts the cursor empty, counts
 *   the whole history once, saves the cursor;
 * - upgraded instance (legacy cursor entry, or a bucket / backup holding
 *   OpenClaw usage, or an unreadable or malformed bucket): still refuses
 *   with the bootstrap message and writes no OpenClaw usage or DB cursor;
 * - stored cursor (an existing DB host): resumes from it without checking
 *   history, whatever the legacy cursor and bucket store hold.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TOKEN_METRICS_CURSOR_KEY,
  TOKEN_METRICS_DB_CURSOR_KEY,
} from '../../lib/constants.js';
import type { HourlyBucket } from '../types/token-metrics.js';
import { readBucket } from './bucket-io.js';
import { parseDbCursorState } from './openclaw-db/db-cursor.js';
import { createV23Fixture } from './openclaw-db/test-fixture-v23.js';

const MODEL = 'anthropic/claude-sonnet-4-6';
const REFUSAL =
  '[token-metrics] No OpenClaw DB cursor in runner state; refusing to collect OpenClaw usage from zero (it would double count history). ' +
  'Bootstrap once with: tsx src/admin/regenerate-token-metrics.ts --from <OpenClaw 2026.9 upgrade hour, ISO>';
const HOUR = '2026-06-15T10';
const OLD_HOUR = '2026-06-14T09';
const LEGACY_CURSOR = {
  [TOKEN_METRICS_CURSOR_KEY]: JSON.stringify({
    'a.jsonl': { byteOffset: 10, lastTimestamp: 1 },
  }),
};

const header = (id: string) =>
  JSON.stringify({ type: 'session', version: 3, id });
const usage = (input: number) =>
  JSON.stringify({
    type: 'message',
    timestamp: '2026-06-15T10:30:00Z',
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      usage: {
        input,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input,
      },
    },
  });

const entry = (input: number) => ({
  input: { count: input, cost: 0 },
  output: { count: 0, cost: 0 },
  cacheRead: { count: 0, cost: 0 },
  cacheWrite: { count: 0, cost: 0 },
});
const bucket = (hour: string, channel: string): HourlyBucket => ({
  hour,
  channels: { [channel]: { models: { [MODEL]: entry(7) } } },
});

let root: string;
let bucketDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-fresh-'));
  bucketDir = path.join(root, 'token-metrics');
  fs.mkdirSync(bucketDir);
  // Lives beside the buckets in production; must not count as a bucket.
  fs.writeFileSync(
    path.join(bucketDir, 'token-rates.json'),
    JSON.stringify({
      models: {
        [MODEL]: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      },
      updatedAt: '2026-06-15T00:00:00Z',
    }),
  );
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

/** Write a file at `{bucketDir}/2026/06/<name>`. */
function writeBucketFile(name: string, content: unknown): void {
  const dir = path.join(bucketDir, '2026', '06');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, name),
    typeof content === 'string' ? content : JSON.stringify(content),
  );
}

/** Run one collection against a fixture DB holding session s1 (seq 1..2). */
async function run(initialState: Record<string, string> = {}) {
  const fx = createV23Fixture(root);
  fx.addHotSession('s1', [header('s1'), usage(1), usage(2)]);
  fx.close();

  vi.resetModules();
  vi.doMock(
    '../../lib/constants.js',
    async (importOriginal: () => Promise<Record<string, unknown>>) => ({
      ...(await importOriginal()),
      TOKEN_RATES_PATH: path.join(bucketDir, 'token-rates.json'),
    }),
  );
  const { runCollect } = await import('./collect-run.js');
  const { flushBuckets } = await import('./bucket-io.js');
  const { hasOpenClawBuckets } = await import('./fresh-openclaw-history.js');
  const bucketCheck = vi.fn(() => hasOpenClawBuckets(bucketDir));

  const state = new Map(Object.entries(initialState));
  const code = await runCollect({
    agentDbPath: fx.dbPath,
    sessionsDir: fx.sessionsDir,
    useDb: true,
    cutoffMs: Date.parse('2026-06-15T11:00:00Z'),
    loadOpenClawCollector: () => import('./openclaw-db/collect-openclaw.js'),
    scanLegacy: () => {
      throw new Error('legacy path must not run on a DB host');
    },
    scanClaudeCode: () => ({ ccProcessed: 0, ccSkipped: 0 }),
    ensureRateCard: () => undefined,
    knownModels: () => ({ [MODEL]: {} }),
    triggerRateCardRefresh: () => undefined,
    nameDms: () => Promise.resolve(),
    flush: (b) => flushBuckets(b, bucketDir),
    hasOpenClawBuckets: bucketCheck,
    openState: () => ({
      get: (k) => state.get(k) ?? null,
      set: (k, v) => {
        state.set(k, v);
      },
      close: () => undefined,
    }),
  });
  return { code, state, bucketCheck };
}

/** Input tokens counted for the fixture session (undefined: none). */
function counted(hour: string): number | undefined {
  const channels = readBucket(hour, bucketDir)?.channels;
  return channels && 'unknown' in channels
    ? channels.unknown.models[MODEL].input.count
    : undefined;
}

/** The saved DB cursor's lastSeq for session s1 (undefined: none saved). */
function savedSeq(state: Map<string, string>): number | undefined {
  return parseDbCursorState(state.get(TOKEN_METRICS_DB_CURSOR_KEY) ?? null)?.[
    'session:s1'
  ].lastSeq;
}

describe('collect-token-metrics without a stored OpenClaw DB cursor', () => {
  it.each<[string, Record<string, string>]>([
    ['no legacy cursor', {}],
    ['an empty legacy cursor', { [TOKEN_METRICS_CURSOR_KEY]: '{}' }],
  ])(
    'fresh instance (%s): starts the cursor empty and counts the whole history once',
    async (_label, initial) => {
      // Claude Code usage collected on earlier (refused) runs doesn't count.
      writeBucketFile(`${OLD_HOUR}.json`, bucket(OLD_HOUR, 'cc:jeeves'));

      const { code, state } = await run(initial);

      expect(code).toBe(0);
      expect(process.exitCode).toBeUndefined();
      expect(console.error).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('fresh instance'),
      );
      expect(counted(HOUR)).toBe(3);
      expect(savedSeq(state)).toBe(2);
    },
  );

  it.each<[string, Record<string, string>, () => void]>([
    ['a legacy JSONL cursor entry', LEGACY_CURSOR, () => undefined],
    [
      'a bucket holding OpenClaw usage',
      {},
      () => {
        writeBucketFile(`${OLD_HOUR}.json`, {
          hour: OLD_HOUR,
          channels: {
            'cc:jeeves': { models: { [MODEL]: entry(7) } },
            'slack:channel:#general': { models: { [MODEL]: entry(7) } },
          },
        });
      },
    ],
    [
      'only a regen backup holding OpenClaw usage',
      {},
      () => {
        writeBucketFile(
          `${OLD_HOUR}.backup-2026-06-15T00-00-00-000Z.json`,
          bucket(OLD_HOUR, 'slack:channel:#general'),
        );
      },
    ],
    [
      'an unreadable bucket',
      {},
      () => {
        writeBucketFile(`${OLD_HOUR}.json`, '{ not json');
      },
    ],
    [
      'a bucket with null channels',
      {},
      () => {
        writeBucketFile(`${OLD_HOUR}.json`, { hour: OLD_HOUR, channels: null });
      },
    ],
  ])(
    'upgraded instance (%s): still refuses with the bootstrap message',
    async (_label, initial, arrange) => {
      arrange();

      const { state } = await run(initial);

      expect(console.error).toHaveBeenCalledWith(REFUSAL);
      expect(process.exitCode).toBe(1);
      expect(state.has(TOKEN_METRICS_DB_CURSOR_KEY)).toBe(false);
      expect(counted(HOUR)).toBeUndefined();
    },
  );

  // A stored cursor after seq 1 counts only seq 2; an empty one counts both.
  it.each<[string, string, number]>([
    [
      'a stored cursor',
      JSON.stringify({ 'session:s1': { lastSeq: 1, lastTimestamp: 0 } }),
      2,
    ],
    ['an empty stored cursor', '{}', 3],
  ])(
    'existing DB host (%s): resumes from it without checking history',
    async (_label, rawCursor, expected) => {
      // Legacy cursor and OpenClaw buckets, as on an upgraded host.
      writeBucketFile(`${OLD_HOUR}.json`, bucket(OLD_HOUR, 'slack:channel:#g'));

      const { code, state, bucketCheck } = await run({
        ...LEGACY_CURSOR,
        [TOKEN_METRICS_DB_CURSOR_KEY]: rawCursor,
      });

      expect(code).toBe(0);
      expect(process.exitCode).toBeUndefined();
      expect(console.error).not.toHaveBeenCalled();
      expect(bucketCheck).not.toHaveBeenCalled();
      expect(console.log).not.toHaveBeenCalledWith(
        expect.stringContaining('fresh instance'),
      );
      expect(counted(HOUR)).toBe(expected);
      expect(savedSeq(state)).toBe(2);
    },
  );
});
