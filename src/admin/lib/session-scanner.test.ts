/**
 * Tests for session-scanner shared scanning logic.
 *
 * Uses a temp directory with fixture JSONL files (session-scanner.fixtures.ts);
 * each test re-imports session-scanner with its constants pointed there.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CursorState } from '../types/token-metrics.js';
import {
  createScannerFixture,
  ocLine,
  type ScannerFixture,
  userLine,
} from './session-scanner.fixtures.js';

let fx: ScannerFixture;
beforeEach(() => {
  fx = createScannerFixture();
});
afterEach(() => {
  fx.cleanup();
});

describe('scanAllSessions', () => {
  it('returns empty result when no session files exist', async () => {
    const scan = await fx.loadScanner();
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

    fs.writeFileSync(path.join(fx.sessionsDir, 'test-session.jsonl'), content);

    const scan = await fx.loadScanner();
    const cursors: CursorState = {};
    const ccCursors: CursorState = {};

    const result = scan(0, cutoff, cursors, ccCursors);

    expect(result.ocProcessed).toBe(1);
    expect(result.seenModels.has('anthropic/claude-sonnet-4-6')).toBe(true);
    expect(result.buckets.size).toBe(1);

    const bucket = result.buckets.get('2026-06-15T10');
    const channels = Object.values(bucket?.channels ?? {});
    expect(channels).toHaveLength(1);
    const usage = channels[0].models['anthropic/claude-sonnet-4-6'];
    expect(usage.input.count).toBe(200);
    expect(usage.output.count).toBe(100);
    expect(usage.input.cost).toBeGreaterThan(0);
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

    fs.writeFileSync(path.join(fx.sessionsDir, 'range-test.jsonl'), content);

    const scan = await fx.loadScanner();
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
    fs.writeFileSync(path.join(fx.sessionsDir, fileName), content);

    const scan = await fx.loadScanner();
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
    const filePath = path.join(fx.sessionsDir, fileName);
    fs.writeFileSync(filePath, content);

    const stat = fs.statSync(filePath);

    const scan = await fx.loadScanner();
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
      path.join(fx.sessionsDir, 'session.jsonl.deleted.2026-06-15'),
      content,
    );
    fs.writeFileSync(
      path.join(fx.sessionsDir, 'session.jsonl.reset.2026-06-15'),
      content,
    );

    const scan = await fx.loadScanner();
    const cursors: CursorState = {};
    const ccCursors: CursorState = {};

    const result = scan(0, cutoff, cursors, ccCursors);

    expect(result.ocProcessed).toBe(2);
  });

  it('ignores non-JSONL files', async () => {
    fs.writeFileSync(path.join(fx.sessionsDir, 'readme.txt'), 'not a session');
    fs.writeFileSync(path.join(fx.sessionsDir, 'data.json'), '{}');

    const scan = await fx.loadScanner();
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
        fs.rmSync(fx.sessionsDir, { recursive: true, force: true });
      },
    ],
    ['empty', () => undefined],
  ])(
    'skips OpenClaw and keeps collecting Claude Code when SESSIONS_DIR is %s',
    async (label, prepare) => {
      prepare();
      const ts = '2026-06-15T10:30:00Z';
      fx.writeCCFixture(ts);
      const warn = vi.mocked(console.warn);

      const scan = await fx.loadScanner();
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

    fs.writeFileSync(path.join(fx.sessionsDir, 'multi-model.jsonl'), content);

    const scan = await fx.loadScanner();
    const cursors: CursorState = {};
    const ccCursors: CursorState = {};

    const result = scan(0, cutoff, cursors, ccCursors);

    expect(result.seenModels.size).toBe(2);
    expect(result.seenModels.has('anthropic/claude-sonnet-4-6')).toBe(true);
    expect(result.seenModels.has('openai/gpt-5.5')).toBe(true);
  });
});
