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
import {
  AGENT_TOOLS_POLICY,
  SPAWN_LAUNCH_REQUEST,
} from './openclaw-dist-fixtures.js';
import { patchSpawnFlag } from './subagent-message-patches.js';
import { planAcrossFiles } from './text-patch.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-patch-io-'));
  fs.writeFileSync(
    path.join(dir, 'sessions-spawn-tool-AB.mjs'),
    SPAWN_LAUNCH_REQUEST,
  );
  fs.writeFileSync(
    path.join(dir, 'agent-tools.policy-CD.mjs'),
    AGENT_TOOLS_POLICY,
  );
  fs.writeFileSync(path.join(dir, 'legacy-EF.js'), 'const a = 1;');
  fs.writeFileSync(path.join(dir, 'types.d.ts'), 'AGENT_LANE_SUBAGENT');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const plan = () =>
  planAcrossFiles(
    findChunks(dir, 'AGENT_LANE_SUBAGENT').map((c) => ({
      file: c.file,
      result: patchSpawnFlag(c.content),
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
      'sessions-spawn-tool-AB.mjs',
    ]);
  });

  it('finds chunks by content marker', () => {
    expect(findChunks(dir, 'AGENT_LANE_SUBAGENT').map((c) => c.file)).toEqual([
      'sessions-spawn-tool-AB.mjs',
    ]);
  });
});

describe('applyDistPlan', () => {
  const target = () => path.join(dir, 'sessions-spawn-tool-AB.mjs');

  it('dry run previews without writing', () => {
    expect(applyDistPlan('t', 'spawn', dir, plan(), true)).toBe(true);
    expect(fs.readFileSync(target(), 'utf8')).toBe(SPAWN_LAUNCH_REQUEST);
  });

  it('live run writes, then reports already patched', () => {
    expect(applyDistPlan('t', 'spawn', dir, plan(), false)).toBe(true);
    expect(fs.readFileSync(target(), 'utf8')).toContain(
      'disableMessageTool: false',
    );
    const second = plan();
    expect(second.status).toBe('already-patched');
    expect(applyDistPlan('t', 'spawn', dir, second, false)).toBe(true);
  });

  it('returns false on error plans', () => {
    expect(
      applyDistPlan('t', 'x', dir, { status: 'error', message: 'nope' }, true),
    ).toBe(false);
  });
});
