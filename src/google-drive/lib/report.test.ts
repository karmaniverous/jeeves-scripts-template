import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { MetaSyncConfigSchema } from './config.js';
import { defaultSteer, type FetchLike, seedMeta } from './meta-seed.js';
import { plan } from './plan.js';
import { input, item, written } from './plan.test-helper.js';
import { planLines, planSummary, type ReportInput } from './report.js';
import { seedShareMetas } from './seed-metas.js';
import { compactMeta, emptySummary, exitCodeFor } from './summary.js';

describe('meta seeding (§7.3)', () => {
  const respond = (
    status: number,
  ): { fetchFn: FetchLike; bodies: unknown[] } => {
    const bodies: unknown[] = [];
    const fetchFn: FetchLike = (_url, init) => {
      const body: unknown =
        typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      bodies.push(body);
      return Promise.resolve(new Response('nope', { status }));
    };
    return { fetchFn, bodies };
  };

  it('maps 201 → created, 409 → exists, anything else → error', async () => {
    expect(await seedMeta('/p', null, respond(201).fetchFn)).toBe('created');
    expect(await seedMeta('/p', null, respond(409).fetchFn)).toBe('exists');
    await expect(seedMeta('/p', null, respond(500).fetchFn)).rejects.toThrow(
      /HTTP 500 nope/,
    );
  });

  it('seeds only populated dirs without a .meta, with root vs share-point steer', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdrive-seed-'));
    fs.mkdirSync(path.join(root, 'r/s'), { recursive: true });
    fs.writeFileSync(path.join(root, 'r/s/f.md'), 'x');
    fs.mkdirSync(path.join(root, 'empty'));
    fs.mkdirSync(path.join(root, 'r/s/.meta'));
    const { fetchFn, bodies } = respond(201);
    const meta = MetaSyncConfigSchema.parse({ sharePointSteer: 'custom' });
    const out = await seedShareMetas(
      root,
      ['empty', 'r', 'r/s'],
      new Set(['r']),
      meta,
      fetchFn,
    );
    expect(out).toEqual({ seeded: 1, errors: [] });
    expect(bodies).toEqual([
      { path: path.join(root, 'r'), steer: defaultSteer('root', 'r') },
    ]);

    fs.rmSync(path.join(root, 'r/s/.meta'), { recursive: true });
    const failing = await seedShareMetas(
      root,
      ['r/s'],
      new Set(),
      meta,
      respond(500).fetchFn,
    );
    expect(failing.errors).toHaveLength(1);
    const off = await seedShareMetas(
      root,
      ['r'],
      new Set(['r']),
      { ...meta, seed: false },
      fetchFn,
    );
    expect(off.seeded).toBe(0);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('report', () => {
  it('summarizes and lists a plan', () => {
    const p = plan(
      input({
        items: [
          item('n', 'r/n.md'),
          item('u', 'r/u.md', { probeKey: 'md5:new' }),
          item('s', 'r/s.md', { preSkip: 'oversize' }),
          item('m', 'r/moved.md'),
        ],
        ledger: new Map([
          [
            'u',
            written('r/u.md', 'md5:old', {
              pendingSince: '2026-10-05T01:00:00Z',
            }),
          ],
          ['m', written('r/old.md', 'md5:m')],
        ]),
        diskFiles: ['r/u.md', 'r/old.md', 'stray.md'],
        shareDirs: [{ shareId: 'x', rootDir: 'r', sharePointDir: 'r' }],
      }),
    );
    const prepared: ReportInput = {
      items: [item('n', 'r/n.md'), item('u', 'r/u.md')],
      excluded: 2,
    };
    expect(planSummary(prepared, p)).toMatchObject({
      files: 2,
      excluded: 2,
      moves: 1,
      fileDeletes: 1,
      queueUpdates: 1,
      queueNew: 1,
      skippedItems: 1,
      oldestPending: '2026-10-05T01:00:00Z',
    });
    expect(planLines(prepared, p)).toEqual([
      'MOVE r/old.md -> r/moved.md',
      'DELETE stray.md',
      'UPDATE r/u.md',
      'NEW r/n.md',
      'SKIP(oversize) s',
      'META-CANDIDATE r',
    ]);
  });
});

describe('summary', () => {
  it('compacts per-account metadata and flags the guard', () => {
    const s = {
      ...emptySummary('a@example.com', true),
      processed: 3,
      guard: { tripped: true, reason: 'mass-deletion', blocked: 40 },
    };
    const meta = compactMeta([s, emptySummary('b@example.com', false)]);
    expect(meta).toMatch(
      /^a@example\.com live .*done=3 .*GUARD=mass-deletion:40; b@example\.com dry /,
    );
  });

  it('exits non-zero only for guard trips and enumeration errors', () => {
    const ok = {
      ...emptySummary('a', true),
      failed: 4,
      parked: 2,
      heldLocks: ['x'],
    };
    expect(exitCodeFor([ok])).toBe(0);
    expect(exitCodeFor([ok, { ...ok, enumerationErrors: ['boom'] }])).toBe(2);
    expect(
      exitCodeFor([
        { ...ok, guard: { tripped: true, reason: 'x', blocked: 1 } },
      ]),
    ).toBe(2);
  });
});
