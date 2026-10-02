/**
 * Tests for Slack read-position state: positions load from the state
 * file, legacy `lastTs` in channels.json migrates once, positions are
 * written to the state file only (channels.json never regains `lastTs`),
 * writes are atomic, and missing files mean "read from the beginning".
 *
 * @module slack/lib/cursors.test
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadCursors,
  loadPollCursors,
  saveChannels,
  saveCursors,
  writeFileAtomic,
} from './cursors.js';

let dir: string;
let stateFile: string;
let channelsFile: string;

const readJson = (file: string): unknown =>
  JSON.parse(fs.readFileSync(file, 'utf8'));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-cursors-'));
  stateFile = path.join(dir, 'state', 'runner', 'cursors', 'slack.json');
  channelsFile = path.join(dir, 'channels.json');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadCursors', () => {
  it('returns empty state when the state file does not exist', () => {
    expect(loadCursors(stateFile)).toEqual({});
  });

  it('reads positions keyed by channel ID from the state file', () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ C1: '1700000000.000100', C2: '1700000001.000200' }),
    );
    expect(loadCursors(stateFile)).toEqual({
      C1: '1700000000.000100',
      C2: '1700000001.000200',
    });
  });

  it('rejects a state file that is not a JSON object', () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, '["C1"]');
    expect(() => loadCursors(stateFile)).toThrow(/not a JSON object/);
  });
});

describe('loadPollCursors (legacy migration)', () => {
  it('prefers the state file over a legacy lastTs in channels.json', () => {
    saveCursors(stateFile, { C1: '1700000009.000000' });
    const { cursors, migrated } = loadPollCursors(stateFile, {
      C1: { lastTs: '1600000000.000000' },
    });
    expect(cursors).toEqual({ C1: '1700000009.000000' });
    expect(migrated).toBe(0);
  });

  it('falls back to legacy lastTs once and persists it to the state file', () => {
    saveCursors(stateFile, { C1: '1700000009.000000' });
    const channels = {
      C1: { name: 'a', lastTs: '1600000000.000000' },
      C2: { name: 'b', lastTs: '1600000002.000000' },
      C3: { name: 'never-polled', lastTs: '0' },
      C4: { name: 'no-cursor' },
    };

    const { cursors, migrated } = loadPollCursors(stateFile, channels);

    expect(migrated).toBe(1);
    expect(cursors).toEqual({
      C1: '1700000009.000000',
      C2: '1600000002.000000',
    });
    // Persisted before channels.json is rewritten, so the legacy value is
    // not needed again.
    expect(readJson(stateFile)).toEqual(cursors);

    // After channels.json is rewritten (lastTs stripped), a second run
    // still resumes from the migrated position.
    saveChannels(channelsFile, channels);
    const second = loadPollCursors(
      stateFile,
      readJson(channelsFile) as Record<string, { lastTs?: unknown }>,
    );
    expect(second.migrated).toBe(0);
    expect(second.cursors.C2).toBe('1600000002.000000');
  });

  it('starts from the beginning when neither file has a position', () => {
    const { cursors, migrated } = loadPollCursors(stateFile, {
      C1: { name: 'a' },
    });
    expect(cursors).toEqual({});
    expect(migrated).toBe(0);
    expect(fs.existsSync(stateFile)).toBe(false);
  });
});

describe('persisting a poll run', () => {
  it('writes positions to the state file and never into channels.json', () => {
    fs.writeFileSync(
      channelsFile,
      JSON.stringify({ C1: { name: 'a', lastTs: '1600000000.000000' } }),
    );
    const channels = readJson(channelsFile) as Record<
      string,
      { name: string; lastTs?: string; metadata?: Record<string, unknown> }
    >;
    const { cursors } = loadPollCursors(stateFile, channels);

    // Simulate a poll advancing C1 and auto-discovering C2.
    cursors.C1 = '1700000005.000000';
    channels.C2 = { name: 'b', metadata: { project: 'x' } };

    saveCursors(stateFile, cursors);
    saveChannels(channelsFile, channels);

    expect(readJson(stateFile)).toEqual({ C1: '1700000005.000000' });
    expect(readJson(channelsFile)).toEqual({
      C1: { name: 'a' },
      C2: { name: 'b', metadata: { project: 'x' } },
    });
    expect(fs.readFileSync(channelsFile, 'utf8')).not.toContain('lastTs');
    // Caller's in-memory channel objects are not mutated.
    expect(channels.C1.lastTs).toBe('1600000000.000000');
  });

  it('creates the state directory when it is missing', () => {
    saveCursors(stateFile, { C1: '1.0' });
    expect(readJson(stateFile)).toEqual({ C1: '1.0' });
  });
});

describe('writeFileAtomic', () => {
  it('replaces the file and leaves no temp file behind', () => {
    const file = path.join(dir, 'x.json');
    fs.writeFileSync(file, 'old');
    writeFileAtomic(file, 'new');
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
    expect(fs.readdirSync(dir)).toEqual(['x.json']);
  });

  it('leaves the original intact and cleans up when the rename fails', () => {
    const file = path.join(dir, 'x.json');
    fs.writeFileSync(file, 'old');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('rename failed');
    });

    expect(() => {
      writeFileAtomic(file, 'new');
    }).toThrow('rename failed');
    expect(fs.readFileSync(file, 'utf8')).toBe('old');
    expect(fs.readdirSync(dir)).toEqual(['x.json']);
  });
});
