import { describe, expect, it } from 'vitest';

import {
  formatPatchSummary,
  type PatchRunResult,
  runAllPatches,
} from './patch-runner.js';

describe('runAllPatches', () => {
  it('runs every script even after failures and throws', () => {
    const seen: string[] = [];
    const results = runAllPatches(['a.ts', 'b.ts', 'c.ts'], (script) => {
      seen.push(script);
      if (script === 'a.ts') return { script, ok: false, exitCode: 1 };
      if (script === 'b.ts') throw new Error('boom');
      return { script, ok: true, exitCode: 0 };
    });

    expect(seen).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(results).toEqual([
      { script: 'a.ts', ok: false, exitCode: 1 },
      { script: 'b.ts', ok: false, exitCode: null, error: 'boom' },
      { script: 'c.ts', ok: true, exitCode: 0 },
    ]);
  });
});

describe('formatPatchSummary', () => {
  it('reports per-patch status and a failure count', () => {
    const results: PatchRunResult[] = [
      { script: 'a.ts', ok: true, exitCode: 0 },
      { script: 'b.ts', ok: false, exitCode: 1 },
      { script: 'c.ts', ok: false, exitCode: null, error: 'boom' },
    ];
    expect(formatPatchSummary(results)).toEqual([
      '  OK     a.ts',
      '  FAILED b.ts (exit 1)',
      '  FAILED c.ts — boom',
      '  2 of 3 patches FAILED.',
    ]);
  });

  it('reports all succeeded', () => {
    expect(
      formatPatchSummary([{ script: 'a.ts', ok: true, exitCode: 0 }]).at(-1),
    ).toBe('  All 1 patches succeeded.');
  });
});
