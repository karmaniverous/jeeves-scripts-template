import { describe, expect, it } from 'vitest';

import { emptyRecord, type LedgerRecord } from './ledger.js';
import { ancestorDirs, plan } from './plan.js';
import { input, item, written } from './plan.test-helper.js';

describe('plan: change detection (§6.2)', () => {
  it('queues new files and leaves unchanged ones alone', () => {
    const p = plan(
      input({
        items: [item('a', 'r/a.md'), item('b', 'r/b.md')],
        ledger: new Map([['b', written('r/b.md', 'md5:b')]]),
        diskFiles: ['r/b.md'],
      }),
    );
    expect(p.queue).toEqual([{ id: 'a', isUpdate: false }]);
    expect(p.fileDeletes).toEqual([]);
    expect(p.records.get('b')?.pendingSince).toBeNull();
  });

  it('re-queues on content-key change and keeps the old copy meanwhile', () => {
    const p = plan(
      input({
        items: [item('a', 'r/a.md', { probeKey: 'md5:new' })],
        ledger: new Map([['a', written('r/a.md', 'md5:old')]]),
        diskFiles: ['r/a.md'],
      }),
    );
    expect(p.queue).toEqual([{ id: 'a', isUpdate: true }]);
    expect(p.fileDeletes).toEqual([]);
  });

  it('moves (no download) on rename/move with the same content key', () => {
    const p = plan(
      input({
        items: [item('a', 'r/new - tag.md')],
        ledger: new Map([['a', written('r/old - tag.md', 'md5:a')]]),
        diskFiles: ['r/old - tag.md'],
      }),
    );
    expect(p.moves).toEqual([
      { id: 'a', from: 'r/old - tag.md', to: 'r/new - tag.md' },
    ]);
    expect(p.queue).toEqual([]);
    expect(p.fileDeletes).toEqual([]);
  });

  it('refreshes written.modifiedTime on a metadata-only change', () => {
    const p = plan(
      input({
        items: [
          item('a', 'r/a.md', {
            probeKey: 'rev:7',
            modifiedTime: '2026-10-05T08:13:12Z',
          }),
        ],
        ledger: new Map([['a', written('r/a.md', 'rev:7')]]),
        diskFiles: ['r/a.md'],
      }),
    );
    expect(p.queue).toEqual([]);
    expect(p.records.get('a')?.written?.modifiedTime).toBe(
      '2026-10-05T08:13:12Z',
    );
  });
});

describe('plan: un-shares and the owned tree (§6.2.1, §6.5)', () => {
  it('deletes files whose items left the snapshot, and drops their records', () => {
    const p = plan(
      input({
        items: [item('keep', 'r/keep.md')],
        ledger: new Map([
          ['keep', written('r/keep.md', 'md5:keep')],
          ['gone', written('r/gone.md', 'md5:gone')],
        ]),
        diskFiles: ['r/keep.md', 'r/gone.md'],
      }),
    );
    expect(p.fileDeletes).toEqual(['r/gone.md']);
    expect(p.ledgerRemovals).toEqual(['gone']);
  });

  it('deletes stray files the ledger never knew', () => {
    const p = plan(input({ diskFiles: ['stray.md'] }));
    expect(p.fileDeletes).toEqual(['stray.md']);
  });

  it('deletes the local copy when an item becomes non-convertible', () => {
    const p = plan(
      input({
        items: [
          item('a', 'r/a.md', { preSkip: 'non-convertible', kind: null }),
        ],
        ledger: new Map([['a', written('r/a.md', 'md5:a')]]),
        diskFiles: ['r/a.md'],
      }),
    );
    expect(p.fileDeletes).toEqual(['r/a.md']);
    expect(p.records.get('a')?.skipped?.reason).toBe('non-convertible');
  });

  it('keeps a persistent skip until the content key changes', () => {
    const skipped: LedgerRecord = {
      ...emptyRecord(),
      skipped: { reason: 'export-limit' as const, key: 'mt:1' },
    };
    const same = plan(
      input({
        items: [item('a', 'r/a.md', { probeKey: 'mt:1' })],
        ledger: new Map([['a', skipped]]),
      }),
    );
    expect(same.queue).toEqual([]);
    const changed = plan(
      input({
        items: [item('a', 'r/a.md', { probeKey: 'mt:2' })],
        ledger: new Map([['a', skipped]]),
      }),
    );
    expect(changed.queue).toEqual([{ id: 'a', isUpdate: false }]);
  });
});

describe('plan: queue order, backoff, parking (§6.4)', () => {
  it('puts updates first (oldest pending), then new files (newest modifiedTime)', () => {
    const p = plan(
      input({
        items: [
          item('n-old', 'r/1.md', { modifiedTime: '2026-01-01' }),
          item('n-new', 'r/2.md', { modifiedTime: '2026-09-01' }),
          item('u-late', 'r/3.md', { probeKey: 'md5:x' }),
          item('u-early', 'r/4.md', { probeKey: 'md5:x' }),
        ],
        ledger: new Map([
          [
            'u-late',
            written('r/3.md', 'md5:o', {
              pendingSince: '2026-10-05T11:00:00Z',
            }),
          ],
          [
            'u-early',
            written('r/4.md', 'md5:o', {
              pendingSince: '2026-10-05T10:00:00Z',
            }),
          ],
        ]),
        diskFiles: ['r/3.md', 'r/4.md'],
      }),
    );
    expect(p.queue.map((q) => q.id)).toEqual([
      'u-early',
      'u-late',
      'n-new',
      'n-old',
    ]);
  });

  it('skips items in backoff and parked items; unparks on content change', () => {
    const backoff: LedgerRecord = {
      ...emptyRecord(),
      retryAfter: '2026-10-05T13:00:00Z',
      attempts: 1,
    };
    const parked: LedgerRecord = {
      ...emptyRecord(),
      parked: { key: 'md5:p' },
      attempts: 5,
    };
    const p = plan(
      input({
        items: [
          item('b', 'r/b.md'),
          item('p', 'r/p.md', { probeKey: 'md5:p' }),
        ],
        ledger: new Map([
          ['b', backoff],
          ['p', parked],
        ]),
      }),
    );
    expect(p.queue).toEqual([]);
    expect(p.parked).toEqual(['p']);
    const changed = plan(
      input({
        items: [item('p', 'r/p.md', { probeKey: 'md5:p2' })],
        ledger: new Map([['p', parked]]),
      }),
    );
    expect(changed.queue.map((q) => q.id)).toEqual(['p']);
    expect(changed.records.get('p')?.attempts).toBe(0);
  });
});

describe('ancestorDirs', () => {
  it('lists every ancestor, shallowest first', () => {
    expect(ancestorDirs('a/b/c.md')).toEqual(['a', 'a/b']);
    expect(ancestorDirs('c.md')).toEqual([]);
  });
});

describe('plan: disk is the truth (crash recovery)', () => {
  it('re-downloads a recorded copy that is missing from disk', () => {
    const p = plan(
      input({
        items: [item('a', 'r/a.md')],
        ledger: new Map([['a', written('r/a.md', 'md5:a')]]),
      }),
    );
    expect(p.queue).toEqual([{ id: 'a', isUpdate: false }]);
    expect(p.moves).toEqual([]);
  });

  it('adopts a move that finished before its record was saved', () => {
    const p = plan(
      input({
        items: [item('a', 'r/new.md')],
        ledger: new Map([['a', written('r/old.md', 'md5:a')]]),
        diskFiles: ['r/new.md'],
      }),
    );
    expect(p.moves).toEqual([]);
    expect(p.queue).toEqual([]);
    expect(p.records.get('a')?.localPath).toBe('r/new.md');
  });

  it('holds moves (and skips their updates) on enumeration errors; a clean run applies them', () => {
    const ledger = new Map([['a', written('r/x/a.md', 'md5:old')]]);
    const items = [item('a', 'r/a.md', { pathResolved: false })];
    const held = plan(
      input({
        items,
        ledger,
        diskFiles: ['r/x/a.md'],
        diskMetaDirs: ['r/x'],
        enumerationErrors: 1,
      }),
    );
    expect(held.moves).toEqual([]);
    expect(held.heldMoves).toEqual([
      { id: 'a', from: 'r/x/a.md', to: 'r/a.md' },
    ]);
    expect(held.queue).toEqual([]);
    expect(held.fileDeletes).toEqual([]);
    expect(held.metaDeletes).toEqual([]);
    expect(held.desiredDirs.has('r/x')).toBe(true);
    expect(held.records.get('a')?.localPath).toBe('r/x/a.md');

    const clean = plan(input({ items, ledger, diskFiles: ['r/x/a.md'] }));
    expect(clean.heldMoves).toEqual([]);
    expect(clean.moves).toEqual([{ id: 'a', from: 'r/x/a.md', to: 'r/a.md' }]);
  });

  it('keeps unseen records while deletions are blocked', () => {
    const ledger = new Map([['gone', written('r/gone.md', 'md5:g')]]);
    const blocked = plan(
      input({ ledger, diskFiles: ['r/gone.md'], enumerationErrors: 1 }),
    );
    expect(blocked.ledgerRemovals).toEqual([]);
    expect(
      plan(input({ ledger, diskFiles: ['r/gone.md'] })).ledgerRemovals,
    ).toEqual(['gone']);
  });
});
