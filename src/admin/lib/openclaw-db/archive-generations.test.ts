/**
 * Scanner tests for deleted/reset transcript archive generations:
 * generations never merge by seq, an archive continues from the live
 * cursor it was archived from (no double count), a reset-in-place live
 * transcript restarts from seq 0, and fully read archives are marked
 * complete and skipped on later runs.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HourlyBucket } from '../../types/token-metrics.js';
import type { DbCursorState } from './db-cursor.js';
import { createV23Fixture, type V23Fixture } from './test-fixture-v23.js';

const header = (id: string) =>
  JSON.stringify({ type: 'session', version: 3, id });
const usage = (tsIso: string, input: number) =>
  JSON.stringify({
    type: 'message',
    timestamp: tsIso,
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

const T10 = '2026-06-15T10:30:00Z';
const T11 = '2026-06-15T11:30:00Z';
const TO = new Date('2026-06-15T12:00:00Z').getTime();

let root: string;
let n = 0;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-db-gen-'));
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
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A fresh fixture DB (a new store state) under the test root. */
function fixture(): V23Fixture {
  n++;
  return createV23Fixture(path.join(root, `db${String(n)}`));
}

async function scanner() {
  vi.resetModules();
  vi.doMock(
    '../../../lib/constants.js',
    async (importOriginal: () => Promise<Record<string, unknown>>) => ({
      ...(await importOriginal()),
      TOKEN_RATES_PATH: path.join(root, 'token-rates.json'),
    }),
  );
  const { scanOpenClawDb } = await import('./scan-openclaw-db.js');
  return (fx: V23Fixture, cursors: DbCursorState, toMs = TO) => {
    const buckets = new Map<string, HourlyBucket>();
    const stats = scanOpenClawDb({
      dbPath: fx.dbPath,
      sessionsDir: fx.sessionsDir,
      cursors,
      options: { fromMs: 0, toMs },
      buckets,
      seenModels: new Set(),
    });
    let input = 0;
    for (const b of buckets.values())
      for (const c of Object.values(b.channels))
        for (const m of Object.values(c.models)) input += m.input.count;
    return { stats, input };
  };
}

describe('archive generations', () => {
  it('counts two generations of one session separately, both from seq 0', async () => {
    const scan = await scanner();
    const fx = fixture();
    fx.addArchive(
      's',
      [header('s'), usage(T10, 1), usage(T10, 2)],
      'reset',
      'g1',
    );
    fx.addArchive('s', [header('s'), usage(T11, 10)], 'reset', 'g2');
    fx.close();

    const cursors: DbCursorState = {};
    expect(scan(fx, cursors).input).toBe(13);
    expect(cursors['session:s#g1']).toMatchObject({
      lastSeq: 2,
      generation: 'g1',
    });
    expect(cursors['session:s#g2']).toMatchObject({
      lastSeq: 1,
      generation: 'g2',
    });
    expect(cursors['session:s']).toBeUndefined();
  });

  it('continues a deleted session archive from the live cursor it was counted to', async () => {
    const scan = await scanner();
    const live = fixture();
    live.addHotSession('s', [header('s'), usage(T10, 1)], [], {
      generation: 'g1',
    });
    live.close();
    const cursors: DbCursorState = {};
    expect(scan(live, cursors).input).toBe(1);
    expect(cursors['session:s']).toMatchObject({
      lastSeq: 1,
      generation: 'g1',
    });

    const deleted = fixture();
    deleted.addArchive(
      's',
      [header('s'), usage(T10, 1), usage(T11, 5)],
      'deleted',
      'g1',
    );
    deleted.close();
    expect(scan(deleted, cursors).input).toBe(5);
    expect(cursors['session:s#g1']).toMatchObject({
      lastSeq: 2,
      complete: true,
    });
  });

  it('inherits an unstamped live cursor only for the newest archive of a gone session', async () => {
    const scan = await scanner();
    const fx = fixture();
    fx.addArchive('s', [header('s'), usage(T10, 100)], 'reset', 'g1');
    fx.addArchive(
      's',
      [header('s'), usage(T10, 1), usage(T11, 5)],
      'deleted',
      'g2',
    );
    fx.close();
    const cursors: DbCursorState = {
      'session:s': { lastSeq: 1, lastTimestamp: 0 },
    };
    expect(scan(fx, cursors).input).toBe(105);
  });

  it('restarts a reset-in-place live transcript and hands its old cursor to the archive', async () => {
    const scan = await scanner();
    const cursors: DbCursorState = {
      'session:s': { lastSeq: 2, lastTimestamp: 0, generation: 'g1' },
    };
    const fx = fixture();
    fx.addArchive(
      's',
      [header('s'), usage(T10, 1), usage(T10, 2), usage(T11, 4)],
      'reset',
      'g1',
    );
    fx.addHotSession('s', [header('s'), usage(T11, 20)], [], {
      generation: 'g2',
    });
    fx.close();

    expect(scan(fx, cursors).input).toBe(24);
    expect(cursors['session:s']).toMatchObject({
      lastSeq: 1,
      generation: 'g2',
    });
    expect(cursors['session:s#g1']).toMatchObject({
      lastSeq: 3,
      complete: true,
    });
  });

  it('marks fully read archives complete and skips them without loading', async () => {
    const scan = await scanner();
    const fx = fixture();
    fx.addArchive(
      's',
      [header('s'), usage(T10, 1), usage(T11, 2)],
      'deleted',
      'g1',
    );
    fx.close();
    fs.writeFileSync(
      path.join(fx.sessionsDir, 'old.jsonl.reset.2026-06-15'),
      [header('old'), usage(T10, 3)].join('\n'),
    );

    const cursors: DbCursorState = {};
    const partial = scan(
      fx,
      cursors,
      new Date('2026-06-15T11:00:00Z').getTime(),
    );
    expect(partial.input).toBe(4);
    expect(cursors['session:s#g1'].complete).toBeUndefined();
    expect(cursors['legacy:old.jsonl.reset.2026-06-15'].complete).toBe(true);

    const full = scan(fx, cursors);
    expect(full.input).toBe(2);
    expect(cursors['session:s#g1'].complete).toBe(true);

    const again = scan(fx, cursors);
    expect(again.input).toBe(0);
    expect(again.stats.transcriptsProcessed).toBe(0);
    expect(again.stats.transcriptsSkipped).toBe(2);
  });
});
