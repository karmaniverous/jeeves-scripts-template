/**
 * Regression tests for #61: records in the still-open hour, and a
 * half-written last line, are counted by a later run exactly once.
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

describe('open-hour records across runs (#61)', () => {
  const hour = (h: string) => new Date(`2026-06-15T${h}:00:00Z`).getTime();

  it('OpenClaw: a record in the open hour is counted by the next run', async () => {
    const file = path.join(fx.sessionsDir, 'open-hour.jsonl');
    fs.writeFileSync(
      file,
      [
        userLine('System: Slack message in #t from User: hi'),
        ocLine({ tsIso: '2026-06-15T09:50:00Z' }),
        ocLine({ tsIso: '2026-06-15T10:30:00Z' }),
      ].join('\n') + '\n',
    );
    const scan = await fx.loadScanner();
    const cursors: CursorState = {};
    const ccCursors: CursorState = {};

    // 10:40: cutoff 10:00 counts 09:50 and stops at 10:30.
    const first = scan(0, hour('10'), cursors, ccCursors);
    expect([...first.buckets.keys()]).toEqual(['2026-06-15T09']);

    // 11:05: cutoff 11:00 resumes at the 10:30 record and counts it once.
    const second = scan(0, hour('11'), cursors, ccCursors);
    expect([...second.buckets.keys()]).toEqual(['2026-06-15T10']);

    // Nothing left: a third run counts nothing.
    const third = scan(0, hour('12'), cursors, ccCursors);
    expect(third.buckets.size).toBe(0);
  });

  it('OpenClaw: a half-written tail line is re-read, not skipped', async () => {
    const file = path.join(fx.sessionsDir, 'partial.jsonl');
    const full = ocLine({ tsIso: '2026-06-15T09:40:00Z' });
    fs.writeFileSync(
      file,
      ocLine({ tsIso: '2026-06-15T09:20:00Z' }) + '\n' + full.slice(0, 20),
    );
    const scan = await fx.loadScanner();
    const cursors: CursorState = {};
    const ccCursors: CursorState = {};

    scan(0, hour('11'), cursors, ccCursors);
    fs.writeFileSync(
      file,
      ocLine({ tsIso: '2026-06-15T09:20:00Z' }) + '\n' + full + '\n',
    );
    const second = scan(0, hour('11'), cursors, ccCursors);
    expect(second.buckets.has('2026-06-15T09')).toBe(true);
  });

  it('Claude Code: a record in the open hour is counted by the next run', async () => {
    fx.writeCCFixture('2026-06-15T10:30:00Z');
    const scan = await fx.loadScanner();
    const cursors: CursorState = {};
    const ccCursors: CursorState = {};

    const first = scan(0, hour('10'), cursors, ccCursors);
    expect(first.buckets.size).toBe(0);

    const second = scan(0, hour('11'), cursors, ccCursors);
    expect([...second.buckets.keys()]).toEqual(['2026-06-15T10']);

    const third = scan(0, hour('12'), cursors, ccCursors);
    expect(third.buckets.size).toBe(0);
  });
});
