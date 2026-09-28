import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyDistPlan,
  findChunks,
  isDryRun,
  listDistChunks,
} from './dist-patch-io.js';
import { evaluateAnchoredPatch, planAcrossFiles } from './text-patch.js';

/** Content marker used to locate the target chunk. */
const MARKER = 'SAMPLE_PATCH_SITE';

/** Synthetic dist chunk carrying the patch site. */
const TARGET = [
  '//#region src/sample.ts',
  `const ${MARKER} = { enabled: true };`,
  'export { SAMPLE_PATCH_SITE };',
].join('\n');

/** Sample anchored patch: flip `enabled: true` to `false` at the marker. */
const samplePatch = (content: string) =>
  evaluateAnchoredPatch(
    content,
    /SAMPLE_PATCH_SITE = \{ enabled: true \}/g,
    /SAMPLE_PATCH_SITE = \{ enabled: false \}/g,
    (m) => m.replace('true', 'false'),
  );

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-patch-io-'));
  fs.writeFileSync(path.join(dir, 'sample-tool-AB.mjs'), TARGET);
  fs.writeFileSync(path.join(dir, 'agent-tools.policy-CD.mjs'), 'const b = 2;');
  fs.writeFileSync(path.join(dir, 'legacy-EF.js'), 'const a = 1;');
  fs.writeFileSync(path.join(dir, 'types.d.ts'), MARKER);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const plan = () =>
  planAcrossFiles(
    findChunks(dir, MARKER).map((c) => ({
      file: c.file,
      result: samplePatch(c.content),
    })),
  );

describe('isDryRun', () => {
  it('detects --dry-run', () => {
    expect(isDryRun(['node', 'x', '--dry-run'])).toBe(true);
    expect(isDryRun(['node', 'x'])).toBe(false);
  });
});

describe('listDistChunks / findChunks', () => {
  it('lists .js and .mjs only', () => {
    expect(listDistChunks(dir)).toEqual([
      'agent-tools.policy-CD.mjs',
      'legacy-EF.js',
      'sample-tool-AB.mjs',
    ]);
  });

  it('finds chunks by content marker', () => {
    expect(findChunks(dir, MARKER).map((c) => c.file)).toEqual([
      'sample-tool-AB.mjs',
    ]);
  });
});

describe('applyDistPlan', () => {
  const target = () => path.join(dir, 'sample-tool-AB.mjs');

  it('dry run previews without writing', () => {
    expect(applyDistPlan('t', 'sample', dir, plan(), true)).toBe(true);
    expect(fs.readFileSync(target(), 'utf8')).toBe(TARGET);
  });

  it('live run writes, then reports already patched', () => {
    expect(applyDistPlan('t', 'sample', dir, plan(), false)).toBe(true);
    expect(fs.readFileSync(target(), 'utf8')).toContain(
      'SAMPLE_PATCH_SITE = { enabled: false }',
    );
    const second = plan();
    expect(second.status).toBe('already-patched');
    expect(applyDistPlan('t', 'sample', dir, second, false)).toBe(true);
  });

  it('returns false on error plans', () => {
    expect(
      applyDistPlan('t', 'x', dir, { status: 'error', message: 'nope' }, true),
    ).toBe(false);
  });
});
