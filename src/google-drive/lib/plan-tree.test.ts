import { describe, expect, it } from 'vitest';

import { plan } from './plan.js';
import { input, item, written } from './plan.test-helper.js';

describe('plan: canonical tree and metas (§7)', () => {
  // Worked example (spec §7.2): folder share a/b plus a separate share
  // of file a/b/c/d.txt; metas at <mike>, <mike>/a/b, <mike>/a/b/c.
  const metas = ['m', 'm/a/b', 'm/a/b/c'];
  const ledger = new Map([
    ['d', written('m/a/b/c/d.txt', 'md5:d')],
    ['e', written('m/a/b/e.txt', 'md5:e')],
  ]);
  const disk = ['m/a/b/c/d.txt', 'm/a/b/e.txt'];

  it('un-sharing the file while the folder still covers it changes nothing', () => {
    const p = plan(
      input({
        items: [
          item('d', 'm/a/b/c/d.txt', { shareIds: ['folder'] }),
          item('e', 'm/a/b/e.txt'),
        ],
        ledger,
        diskFiles: disk,
        diskMetaDirs: metas,
      }),
    );
    expect(p.fileDeletes).toEqual([]);
    expect(p.metaDeletes).toEqual([]);
  });

  it('un-sharing the folder keeps the branch alive for the deeper file share', () => {
    const p = plan(
      input({
        items: [item('d', 'm/a/b/c/d.txt', { shareIds: ['file'] })],
        ledger,
        diskFiles: disk,
        diskMetaDirs: metas,
      }),
    );
    expect(p.fileDeletes).toEqual(['m/a/b/e.txt']);
    expect(p.metaDeletes).toEqual([]); // a/b and a/b/c stay in the tree
  });

  it('un-sharing both removes the branch and every meta in it', () => {
    const p = plan(
      input({
        ledger,
        diskFiles: disk,
        diskMetaDirs: metas,
        deletion: { maxFraction: 1, minCount: 100 },
      }),
    );
    expect(p.fileDeletes).toEqual(['m/a/b/c/d.txt', 'm/a/b/e.txt']);
    expect(p.metaDeletes).toEqual(['m', 'm/a/b', 'm/a/b/c']);
  });

  it('keeps directories of pending new files', () => {
    const p = plan(input({ items: [item('n', 'm/x/n.md')] }));
    expect([...p.desiredDirs].sort()).toEqual(['m', 'm/x']);
  });

  it('lists root and share-point seed candidates once each', () => {
    const p = plan(
      input({
        shareDirs: [
          { shareId: '1', rootDir: 'm', sharePointDir: 'm/a/b' },
          { shareId: '2', rootDir: 'm', sharePointDir: 'm' },
        ],
      }),
    );
    expect(p.seedCandidates).toEqual(['m', 'm/a/b']);
  });
});

describe('plan: mass-deletion guard (§6.5)', () => {
  const many = Array.from({ length: 40 }, (_, i) => `f${String(i)}.md`);

  it('does not trip on small trees (min count)', () => {
    const p = plan(input({ diskFiles: ['a.md', 'b.md', 'c.md'] }));
    expect(p.guard.tripped).toBe(false);
    expect(p.fileDeletes).toHaveLength(3);
  });

  it('trips when both fraction and count are exceeded', () => {
    const p = plan(input({ diskFiles: many }));
    expect(p.guard).toEqual({
      tripped: true,
      reason: 'mass-deletion',
      blocked: 40,
    });
    expect(p.fileDeletes).toEqual([]);
  });

  it('--allow-mass-delete applies guard-blocked deletions', () => {
    expect(
      plan(input({ diskFiles: many, allowMassDelete: true })).fileDeletes,
    ).toHaveLength(40);
  });

  it('enumeration errors block all deletions, even with --allow-mass-delete', () => {
    const p = plan(
      input({
        diskFiles: ['a.md'],
        enumerationErrors: 1,
        allowMassDelete: true,
      }),
    );
    expect(p.guard.reason).toBe('enumeration-error');
    expect(p.fileDeletes).toEqual([]);
  });
});
