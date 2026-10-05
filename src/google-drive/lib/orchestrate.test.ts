import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertDisjointTargets,
  BudgetConfigSchema,
  GoogleDriveConfigSchema,
  parseGoogleDriveConfig,
  resolveTargetDir,
  SyncEntrySchema,
} from './config.js';
import { createRunBudget } from './execute.js';
import { fakeRunner } from './fake-runner.test-helper.js';
import { createLedgerStore } from './ledger.js';
import { lastRunAt, runSyncs, selectSyncs } from './orchestrate.js';
import { emptySummary } from './summary.js';

const a = SyncEntrySchema.parse({ account: 'a@example.com' });
const b = SyncEntrySchema.parse({ account: 'b@example.com' });

describe('selectSyncs', () => {
  it('returns every configured sync without --account', () => {
    expect(selectSyncs([a, b], [], true)).toEqual([a, b]);
  });

  it('filters by --account, case-insensitively', () => {
    expect(selectSyncs([a, b], ['--account', 'B@Example.com'], true)).toEqual([
      b,
    ]);
  });

  it('never synthesizes an entry for a live run', () => {
    expect(selectSyncs([a], ['--account', 'x@other.example'], true)).toEqual(
      [],
    );
  });

  it('synthesizes a dry-run entry, defaulting domains to the account domain', () => {
    const [s] = selectSyncs([], ['--account', 'x@other.example'], false);
    expect(s.account).toBe('x@other.example');
    expect(s.pathResolution.domains).toEqual(['other.example']);
    const [t] = selectSyncs(
      [],
      ['--account', 'x@o.example', '--domains', 'a.com, b.com'],
      false,
    );
    expect(t.pathResolution.domains).toEqual(['a.com', 'b.com']);
  });
});

describe('runSyncs', () => {
  it('runs oldest-last-run first and saves each run state (live only)', async () => {
    const r = fakeRunner();
    createLedgerStore(r.client, 'a@example.com', true).saveRunState({
      lastRunAt: '2026-10-05T10:00:00Z',
    });
    createLedgerStore(r.client, 'b@example.com', true).saveRunState({
      lastRunAt: '2026-10-05T09:00:00Z',
    });
    const order: string[] = [];
    const lines: string[] = [];
    const opts = {
      allowMassDelete: false,
      budget: createRunBudget(BudgetConfigSchema.parse({}), Date.now()),
      shouldStop: () => false,
      log: (acct: string, l: string) => lines.push(`${acct}:${l}`),
    };
    const fakeSync: Parameters<typeof runSyncs>[3] = (cfg, _runner, o) => {
      order.push(cfg.account);
      o.log('hello');
      return Promise.resolve(emptySummary(cfg.account, o.live));
    };

    const live = await runSyncs(
      [a, b],
      r.client,
      { ...opts, live: true },
      fakeSync,
    );
    expect(order).toEqual(['b@example.com', 'a@example.com']);
    expect(live.map((s) => s.account)).toEqual(order);
    expect(lines).toContain('a@example.com:hello');
    const saved = createLedgerStore(
      r.client,
      'b@example.com',
      false,
    ).loadRunState();
    expect(lastRunAt(saved) > '2026-10-05T09:00:00Z').toBe(true);

    const before = JSON.stringify([...r.state]);
    await runSyncs([a], r.client, { ...opts, live: false }, fakeSync);
    expect(JSON.stringify([...r.state])).toBe(before);
  });
});

describe('runSyncs budget', () => {
  it('stops dispatching once the budget is spent, so deferred accounts go first next run', async () => {
    const r = fakeRunner();
    let budgetLeft = true;
    const order: string[] = [];
    const spend: Parameters<typeof runSyncs>[3] = (cfg, _runner, o) => {
      order.push(cfg.account);
      budgetLeft = false; // this account's queue used the whole budget
      return Promise.resolve(emptySummary(cfg.account, o.live));
    };
    const opts = {
      live: true,
      allowMassDelete: false,
      budget: createRunBudget(BudgetConfigSchema.parse({}), Date.now()),
      shouldStop: () => !budgetLeft,
      log: () => undefined,
    };
    await runSyncs([a, b], r.client, opts, spend);
    expect(order).toEqual(['a@example.com']);
    expect(
      lastRunAt(
        createLedgerStore(r.client, 'b@example.com', false).loadRunState(),
      ),
    ).toBe('');
    budgetLeft = true;
    await runSyncs([a, b], r.client, opts, spend);
    expect(order).toEqual(['a@example.com', 'b@example.com']);
  });
});

describe('config', () => {
  it('fills every default from just an account', () => {
    const s = SyncEntrySchema.parse({ account: 'a@example.com' });
    expect(s.targetDir).toBe('google-drive');
    expect(s.meta.lockStaleMinutes).toBe(30);
    expect(s.deletion).toEqual({ maxFraction: 0.2, minCount: 25 });
    const g = GoogleDriveConfigSchema.parse({
      syncs: [{ account: 'a@example.com' }],
    });
    expect(g.budget).toEqual({
      maxSeconds: 360,
      maxItems: null,
      maxBytes: null,
      maxAttempts: 5,
    });
  });

  it('rejects a per-sync budget, pointing at the top-level one', () => {
    expect(() =>
      GoogleDriveConfigSchema.parse({
        syncs: [{ account: 'a@example.com', budget: { maxSeconds: 60 } }],
      }),
    ).toThrow(/move it to googleDrive\.budget/);
  });

  it('loads the block: null when absent, a clear error when invalid', () => {
    expect(parseGoogleDriveConfig(undefined)).toBeNull();
    expect(
      parseGoogleDriveConfig({ syncs: [{ account: 'a@example.com' }] })?.syncs,
    ).toHaveLength(1);
    expect(() => parseGoogleDriveConfig({ syncs: [] })).toThrow(
      /invalid googleDrive block/,
    );
  });

  it('resolves targetDir under the content dir and rejects escapes', () => {
    // Native paths: the same assertions hold on POSIX and Windows.
    const c = path.resolve('/c');
    expect(resolveTargetDir('google-drive', c)).toBe(
      path.join(c, 'google-drive'),
    );
    expect(resolveTargetDir(path.join(c, 'x', 'y'), c)).toBe(
      path.join(c, 'x', 'y'),
    );
    expect(resolveTargetDir('..dots', c)).toBe(path.join(c, '..dots'));
    const bad = [
      path.resolve('/elsewhere'),
      path.join(c, '..', 'd'),
      '../d',
      '.',
      c,
    ];
    for (const b of bad) {
      expect(() => resolveTargetDir(b, c)).toThrow(
        /subdirectory of CONTENT_DIR/,
      );
    }
  });

  it('rejects duplicate accounts and equal or nested targets', () => {
    expect(() =>
      GoogleDriveConfigSchema.parse({
        syncs: [
          { account: 'a@x.example' },
          { account: 'A@x.example', targetDir: 'other' },
        ],
      }),
    ).toThrow(/duplicate/);
    const at = (account: string, targetDir: string) =>
      SyncEntrySchema.parse({ account, targetDir });
    expect(() => {
      assertDisjointTargets([a, b], '/c');
    }).toThrow(/overlapping/); // both default to google-drive
    expect(() => {
      assertDisjointTargets([at('a@x', 'g'), at('b@x', 'g/b')], '/c');
    }).toThrow(/overlapping/);
    expect(() => {
      assertDisjointTargets(
        [at('a@x', 'g/a'), at('b@x', 'g/b'), at('c@x', 'ga')],
        '/c',
      );
    }).not.toThrow();
  });
});
