/**
 * Tests for session-scanner shared scanning logic.
 *
 * Uses a temp directory with fixture JSONL files. Each test re-imports
 * session-scanner after mocking constants to point at the test fixtures.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CursorState } from '../types/token-metrics.js';

// ── Fixtures ───────────────────────────────────────────────────────

/** Build an OpenClaw JSONL usage line. */
function ocLine(opts: {
  tsIso: string;
  model?: string;
  provider?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): string {
  return JSON.stringify({
    type: 'message',
    timestamp: opts.tsIso,
    message: {
      role: 'assistant',
      model: opts.model ?? 'claude-sonnet-4-6',
      provider: opts.provider ?? 'anthropic',
      usage: {
        input: opts.input ?? 100,
        output: opts.output ?? 50,
        cacheRead: opts.cacheRead ?? 0,
        cacheWrite: opts.cacheWrite ?? 0,
        totalTokens:
          (opts.input ?? 100) +
          (opts.output ?? 50) +
          (opts.cacheRead ?? 0) +
          (opts.cacheWrite ?? 0),
      },
    },
  });
}

/** Build an OpenClaw JSONL user message line (for channel detection). */
function userLine(text: string): string {
  return JSON.stringify({
    type: 'message',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  });
}

/** Write a Claude Code session file with one assistant usage line. */
function writeCCFixture(tsIso: string): void {
  const projectDir = path.join(tmpDir, 'cc-projects', 'D--repos-acme-app');
  fs.mkdirSync(projectDir, { recursive: true });
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: tsIso,
    message: {
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  });
  fs.writeFileSync(path.join(projectDir, 'cc-session.jsonl'), line + '\n');
}

// ── Helpers ────────────────────────────────────────────────────────

let tmpDir: string;
let sessionsDir: string;

/** Write a minimal rate card fixture so normalizeUsage doesn't throw. */
function writeRateCardFixture(): void {
  const rateCardDir = path.join(tmpDir, 'config');
  fs.mkdirSync(rateCardDir, { recursive: true });
  const rateCard = {
    models: {
      'anthropic/claude-sonnet-4-6': {
        input: 0.003,
        output: 0.015,
        cacheRead: 0.0003,
        cacheWrite: 0.00375,
      },
      'openai/gpt-5.5': {
        input: 0.005,
        output: 0.015,
        cacheRead: 0.0025,
        cacheWrite: 0.00975,
      },
    },
    updatedAt: '2026-06-15T00:00:00Z',
  };
  fs.writeFileSync(
    path.join(rateCardDir, 'token-rates.json'),
    JSON.stringify(rateCard),
  );
}

/** Re-import session-scanner with mocked constants pointing at tmpDir. */
async function loadScanner() {
  writeRateCardFixture();
  vi.resetModules();
  vi.doMock(
    '../../lib/constants.js',
    async (importOriginal: () => Promise<Record<string, unknown>>) => {
      const actual = await importOriginal();
      return {
        ...actual,
        SESSIONS_DIR: sessionsDir,
        CLAUDE_CODE_PROJECTS_DIR: path.join(tmpDir, 'cc-projects'),
        TOKEN_RATES_PATH: path.join(tmpDir, 'config', 'token-rates.json'),
      };
    },
  );
  const mod = await import('./session-scanner.js');
  return mod.scanAllSessions;
}

// ── Setup ──────────────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-test-'));
  sessionsDir = path.join(tmpDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  // The missing/empty SESSIONS_DIR guard warns; keep test output clean.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ──────────────────────────────────────────────────────────

describe('scanAllSessions', () => {
  it('returns empty result when no session files exist', async () => {
    const scan = await loadScanner();
    const cursors: CursorState = {};
    const ccCursors: CursorState = {};

    const result = scan(0, Date.now(), cursors, ccCursors);

    expect(result.buckets.size).toBe(0);
    expect(result.seenModels.size).toBe(0);
    expect(result.ocProcessed).toBe(0);
    expect(result.ocSkipped).toBe(0);
    expect(result.ccProcessed).toBe(0);
    expect(result.ccSkipped).toBe(0);
  });

  it('extracts usage from a single session file', async () => {
    const ts = '2026-06-15T10:30:00Z';
    const tsMs = new Date(ts).getTime();
    const cutoff = tsMs + 3600_000;

    const content = [
      userLine('System: Slack message in #test-channel from User: hello'),
      ocLine({ tsIso: ts, input: 200, output: 100 }),
    ].join('\n');

    fs.writeFileSync(path.join(sessionsDir, 'test-session.jsonl'), content);

    const scan = await loadScanner();
    const cursors: CursorState = {};
    const ccCursors: CursorState = {};

    const result = scan(0, cutoff, cursors, ccCursors);

    expect(result.ocProcessed).toBe(1);
    expect(result.seenModels.has('anthropic/claude-sonnet-4-6')).toBe(true);
    expect(result.buckets.size).toBe(1);

    const bucket = result.buckets.get('2026-06-15T10');
    expect(bucket).toBeDefined();
  });

  it('respects time range filtering', async () => {
    const earlyTs = '2026-06-15T08:00:00Z';
    const inRangeTs = '2026-06-15T10:30:00Z';
    const lateTs = '2026-06-15T14:00:00Z';

    const fromMs = new Date('2026-06-15T10:00:00Z').getTime();
    const cutoffMs = new Date('2026-06-15T12:00:00Z').getTime();

    const content = [
      userLine('System: Slack message in #test from User: hi'),
      ocLine({ tsIso: earlyTs, input: 100, output: 50 }),
      ocLine({ tsIso: inRangeTs, input: 200, output: 100 }),
      ocLine({ tsIso: lateTs, input: 300, output: 150 }),
    ].join('\n');

    fs.writeFileSync(path.join(sessionsDir, 'range-test.jsonl'), content);

    const scan = await loadScanner();
    const cursors: CursorState = {};
    const ccCursors: CursorState = {};

    const result = scan(fromMs, cutoffMs, cursors, ccCursors);

    expect(result.buckets.size).toBe(1);
    expect(result.buckets.has('2026-06-15T10')).toBe(true);
    expect(result.buckets.has('2026-06-15T08')).toBe(false);
    expect(result.buckets.has('2026-06-15T14')).toBe(false);
  });

  it('updates cursors after processing', async () => {
    const ts = '2026-06-15T10:30:00Z';
    const cutoff = new Date(ts).getTime() + 3600_000;

    const content = [
      userLine('System: Slack message in #test from User: hi'),
      ocLine({ tsIso: ts }),
    ].join('\n');

    const fileName = 'cursor-test.jsonl';
    fs.writeFileSync(path.join(sessionsDir, fileName), content);

    const scan = await loadScanner();
    const cursors: CursorState = {};
    const ccCursors: CursorState = {};

    scan(0, cutoff, cursors, ccCursors);

    expect(cursors[fileName]).toBeDefined();
    expect(cursors[fileName].byteOffset).toBeGreaterThan(0);
    expect(cursors[fileName].lastTimestamp).toBeGreaterThan(0);
  });

  it('skips fully-processed files based on cursor byteOffset', async () => {
    const ts = '2026-06-15T10:30:00Z';
    const cutoff = new Date(ts).getTime() + 3600_000;

    const content = [
      userLine('System: Slack message in #test from User: hi'),
      ocLine({ tsIso: ts }),
    ].join('\n');

    const fileName = 'skip-test.jsonl';
    const filePath = path.join(sessionsDir, fileName);
    fs.writeFileSync(filePath, content);

    const stat = fs.statSync(filePath);

    const scan = await loadScanner();
    const cursors: CursorState = {
      [fileName]: { byteOffset: stat.size, lastTimestamp: 0 },
    };
    const ccCursors: CursorState = {};

    const result = scan(0, cutoff, cursors, ccCursors);

    expect(result.ocSkipped).toBe(1);
    expect(result.ocProcessed).toBe(0);
  });

  it('handles deleted/reset session file suffixes', async () => {
    const ts = '2026-06-15T10:30:00Z';
    const cutoff = new Date(ts).getTime() + 3600_000;

    const content = [
      userLine('System: Slack message in #test from User: hi'),
      ocLine({ tsIso: ts }),
    ].join('\n');

    fs.writeFileSync(
      path.join(sessionsDir, 'session.jsonl.deleted.2026-06-15'),
      content,
    );
    fs.writeFileSync(
      path.join(sessionsDir, 'session.jsonl.reset.2026-06-15'),
      content,
    );

    const scan = await loadScanner();
    const cursors: CursorState = {};
    const ccCursors: CursorState = {};

    const result = scan(0, cutoff, cursors, ccCursors);

    expect(result.ocProcessed).toBe(2);
  });

  it('ignores non-JSONL files', async () => {
    fs.writeFileSync(path.join(sessionsDir, 'readme.txt'), 'not a session');
    fs.writeFileSync(path.join(sessionsDir, 'data.json'), '{}');

    const scan = await loadScanner();
    const cursors: CursorState = {};
    const ccCursors: CursorState = {};

    const result = scan(0, Date.now(), cursors, ccCursors);

    expect(result.ocProcessed).toBe(0);
    expect(result.ocSkipped).toBe(0);
  });

  it.each([
    [
      'missing',
      () => {
        fs.rmSync(sessionsDir, { recursive: true, force: true });
      },
    ],
    ['empty', () => undefined],
  ])(
    'skips OpenClaw and keeps collecting Claude Code when SESSIONS_DIR is %s',
    async (label, prepare) => {
      prepare();
      const ts = '2026-06-15T10:30:00Z';
      writeCCFixture(ts);
      const warn = vi.mocked(console.warn);

      const scan = await loadScanner();
      const result = scan(0, new Date(ts).getTime() + 3600_000, {}, {});

      expect(result.ocProcessed).toBe(0);
      expect(result.ccProcessed).toBe(1);
      expect(
        result.buckets.get('2026-06-15T10')?.channels['cc:acme-app'],
      ).toBeDefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          label === 'missing'
            ? 'SESSIONS_DIR not found'
            : 'no transcript files',
        ),
      );
    },
  );

  it('tracks multiple models in seenModels', async () => {
    const ts1 = '2026-06-15T10:30:00Z';
    const ts2 = '2026-06-15T10:31:00Z';
    const cutoff = new Date(ts1).getTime() + 3600_000;

    const content = [
      userLine('System: Slack message in #test from User: hi'),
      ocLine({
        tsIso: ts1,
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
      }),
      ocLine({
        tsIso: ts2,
        model: 'gpt-5.5',
        provider: 'openai',
      }),
    ].join('\n');

    fs.writeFileSync(path.join(sessionsDir, 'multi-model.jsonl'), content);

    const scan = await loadScanner();
    const cursors: CursorState = {};
    const ccCursors: CursorState = {};

    const result = scan(0, cutoff, cursors, ccCursors);

    expect(result.seenModels.size).toBe(2);
    expect(result.seenModels.has('anthropic/claude-sonnet-4-6')).toBe(true);
    expect(result.seenModels.has('openai/gpt-5.5')).toBe(true);
  });
});
