/**
 * Tests for the collector's incremental OpenClaw DB step: refuses without
 * a stored cursor (would double count), resumes from a stored cursor, and
 * fails loudly on a wrong-schema DB.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HourlyBucket } from '../../types/token-metrics.js';
import { createV23Fixture } from './test-fixture-v23.js';

const header = (id: string) =>
  JSON.stringify({ type: 'session', version: 3, id });
const usage = (tsIso: string, input = 100, output = 50) =>
  JSON.stringify({
    type: 'message',
    timestamp: tsIso,
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      usage: {
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input + output,
      },
    },
  });

const T10 = '2026-06-15T10:30:00Z';
const T11 = '2026-06-15T11:30:00Z';
const ms = (iso: string) => new Date(iso).getTime();

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-db-scan-'));
  fs.writeFileSync(
    path.join(root, 'token-rates.json'),
    JSON.stringify({
      models: {
        'anthropic/claude-sonnet-4-6': {
          input: 3,
          output: 15,
          cacheRead: 0.3,
          cacheWrite: 3.75,
        },
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

async function load() {
  vi.resetModules();
  vi.doMock(
    '../../../lib/constants.js',
    async (importOriginal: () => Promise<Record<string, unknown>>) => ({
      ...(await importOriginal()),
      TOKEN_RATES_PATH: path.join(root, 'token-rates.json'),
    }),
  );
  return {
    ...(await import('./scan-openclaw-db.js')),
    ...(await import('./collect-openclaw.js')),
  };
}

function inputCount(
  buckets: Map<string, HourlyBucket>,
  hour: string,
  channel: string,
): number {
  return (
    buckets.get(hour)?.channels[channel]?.models['anthropic/claude-sonnet-4-6']
      ?.input.count ?? 0
  );
}

describe('collectOpenClawDb', () => {
  it('refuses without a stored cursor (non-zero exit, nothing scanned)', async () => {
    const fx = createV23Fixture(root);
    fx.addHotSession('s1', [header('s1'), usage(T10)]);
    fx.close();
    const { collectOpenClawDb } = await load();
    const buckets = new Map<string, HourlyBucket>();

    const result = collectOpenClawDb({
      dbPath: fx.dbPath,
      sessionsDir: fx.sessionsDir,
      rawCursor: null,
      cutoffMs: ms(T11),
      buckets,
      seenModels: new Set(),
    });

    expect(result).toBeNull();
    expect(buckets.size).toBe(0);
    expect(process.exitCode).toBe(1);
  });

  it('collects incrementally from a stored cursor', async () => {
    const fx = createV23Fixture(root);
    fx.addHotSession('s1', [header('s1'), usage(T10, 1), usage(T10, 2)]);
    fx.close();
    const { collectOpenClawDb } = await load();
    const buckets = new Map<string, HourlyBucket>();

    const result = collectOpenClawDb({
      dbPath: fx.dbPath,
      sessionsDir: fx.sessionsDir,
      rawCursor: JSON.stringify({
        'session:s1': { lastSeq: 1, lastTimestamp: 0 },
      }),
      cutoffMs: ms(T11),
      buckets,
      seenModels: new Set(),
    });

    expect(inputCount(buckets, '2026-06-15T10', 'unknown')).toBe(2);
    expect(result?.['session:s1'].lastSeq).toBe(2);
  });

  it('throws on a wrong-schema DB before collecting anything', async () => {
    const fx = createV23Fixture(root, 24);
    fx.close();
    const { collectOpenClawDb } = await load();

    expect(() =>
      collectOpenClawDb({
        dbPath: fx.dbPath,
        sessionsDir: fx.sessionsDir,
        rawCursor: '{}',
        cutoffMs: ms(T11),
        buckets: new Map(),
        seenModels: new Set(),
      }),
    ).toThrow(/expected user_version 23, found 24/);
  });
});
