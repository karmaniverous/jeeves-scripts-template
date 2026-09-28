/**
 * Tests for the Claude Code scan: incremental mode advances byte cursors;
 * countedOnly (bounded rebuilds) counts only bytes before the stored
 * cursor and never changes it, so a later collection still counts newer
 * records exactly once.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CursorState, HourlyBucket } from '../types/token-metrics.js';

let tmp: string;
let file: string;

const line = (tsIso: string, input: number) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: tsIso,
    message: {
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: input, output_tokens: 0 },
    },
  }) + '\n';

const FIRST = line('2026-09-24T10:00:00Z', 1);
const SECOND = line('2026-09-24T11:00:00Z', 10);
const FROM = Date.parse('2026-09-24T09:00:00Z');
const TO = Date.parse('2026-09-24T12:00:00Z');

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-scan-'));
  const project = path.join(tmp, 'projects', 'D--repos-acme-app');
  fs.mkdirSync(project, { recursive: true });
  file = path.join(project, 'session.jsonl');
  fs.writeFileSync(file, FIRST + SECOND);
  fs.writeFileSync(
    path.join(tmp, 'token-rates.json'),
    JSON.stringify({
      models: {
        'anthropic/claude-sonnet-4-6': {
          input: 3,
          output: 15,
          cacheRead: 0.3,
          cacheWrite: 3.75,
        },
      },
      updatedAt: '2026-09-24T00:00:00Z',
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function load() {
  vi.resetModules();
  vi.doMock(
    '../../lib/constants.js',
    async (importOriginal: () => Promise<Record<string, unknown>>) => ({
      ...(await importOriginal()),
      CLAUDE_CODE_PROJECTS_DIR: path.join(tmp, 'projects'),
      TOKEN_RATES_PATH: path.join(tmp, 'token-rates.json'),
    }),
  );
  const { scanClaudeCodeSessions } =
    await import('./claude-code-session-scan.js');
  return (cursors: CursorState, countedOnly = false) => {
    const buckets = new Map<string, HourlyBucket>();
    const stats = scanClaudeCodeSessions(
      FROM,
      TO,
      cursors,
      buckets,
      new Set(),
      { countedOnly },
    );
    let input = 0;
    for (const b of buckets.values())
      for (const c of Object.values(b.channels))
        for (const m of Object.values(c.models)) input += m.input.count;
    return { ...stats, input };
  };
}

describe('scanClaudeCodeSessions', () => {
  it('incremental mode counts from the cursor and advances it', async () => {
    const scan = await load();
    const cursors: CursorState = {};
    expect(scan(cursors).input).toBe(11);
    const [key] = Object.keys(cursors);
    expect(cursors[key].byteOffset).toBe(fs.statSync(file).size);
    expect(scan(cursors).ccSkipped).toBe(1);
  });

  it('countedOnly counts only bytes before the stored cursor and leaves it unchanged', async () => {
    const scan = await load();
    const probe: CursorState = {};
    fs.writeFileSync(file, FIRST);
    scan(probe);
    const [key] = Object.keys(probe);
    fs.writeFileSync(file, FIRST + SECOND);
    const stored: CursorState = {
      [key]: { byteOffset: Buffer.byteLength(FIRST), lastTimestamp: 0 },
    };
    const before = structuredClone(stored);

    const rebuilt = scan(stored, true);
    expect(rebuilt.input).toBe(1);
    expect(stored).toEqual(before);

    // The next incremental run still counts the newer record once.
    expect(scan(stored).input).toBe(10);
  });

  it('countedOnly skips files the collector has never read', async () => {
    const scan = await load();
    const result = scan({}, true);
    expect(result.input).toBe(0);
    expect(result.ccSkipped).toBe(1);
  });
});
