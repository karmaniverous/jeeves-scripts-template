/**
 * Tests for `saveChannels()`, the single writer of `channels.json`:
 * `lastTs` is stripped without mutating the caller's map, curated fields
 * and key order survive, output matches the committed formatting (2-space
 * JSON, exactly one trailing newline) so an unchanged map rewrites
 * byte-identically, and write failures surface to the caller.
 *
 * @module slack/lib/cursors.save-channels.test
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { saveChannels } from './cursors.js';

/** Committed style: prettier JSON, 2-space indent, one trailing newline. */
const COMMITTED = [
  '{',
  '  "C1": {',
  '    "name": "general",',
  '    "type": "channel",',
  '    "metadata": {},',
  '    "_account": "default"',
  '  },',
  '  "D1": {',
  '    "name": "dm-U1",',
  '    "type": "dm",',
  '    "isPrivate": true,',
  '    "_autoDiscovered": "2026-10-02T09:05:23.665Z"',
  '  }',
  '}',
  '',
].join('\n');

type Entries = Record<string, Record<string, unknown>>;

let dir: string;
let channelsFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-channels-'));
  channelsFile = path.join(dir, 'channels.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('saveChannels', () => {
  it('never writes lastTs to channels.json and keeps curated fields', () => {
    const channels = {
      C1: {
        name: 'general',
        type: 'channel',
        lastTs: '1700000000.000100',
        metadata: { topic: 'x' },
        _account: 'default',
      },
      C2: { name: 'dm-U1', type: 'dm' },
    };

    saveChannels(channelsFile, channels);

    const raw = fs.readFileSync(channelsFile, 'utf8');
    expect(raw).not.toMatch(/lastTs/);
    expect(JSON.parse(raw)).toEqual({
      C1: {
        name: 'general',
        type: 'channel',
        metadata: { topic: 'x' },
        _account: 'default',
      },
      C2: { name: 'dm-U1', type: 'dm' },
    });
    // The caller's in-memory objects are not mutated.
    expect(channels.C1.lastTs).toBe('1700000000.000100');
  });

  it('ends the file with exactly one trailing newline', () => {
    saveChannels(channelsFile, { C1: { name: 'general', type: 'channel' } });

    const raw = fs.readFileSync(channelsFile, 'utf8');
    expect(raw.endsWith('}\n')).toBe(true);
    expect(raw.endsWith('\n\n')).toBe(false);
  });

  it('rewrites an unchanged, committed-style map byte-identically', () => {
    fs.writeFileSync(channelsFile, COMMITTED, 'utf8');
    const before = fs.readFileSync(channelsFile);

    saveChannels(channelsFile, JSON.parse(COMMITTED) as Entries);

    expect(fs.readFileSync(channelsFile).equals(before)).toBe(true);
  });

  it('keeps channel and field order, so stripping lastTs restores the committed bytes', () => {
    const channels = JSON.parse(COMMITTED) as Entries;
    // A legacy lastTs in the middle of an entry, and one as its last key.
    channels.C1 = {
      name: 'general',
      lastTs: '1700000000.000100',
      type: 'channel',
      metadata: {},
      _account: 'default',
    };
    channels.D1.lastTs = '1700000500.000200';

    saveChannels(channelsFile, channels);

    expect(fs.readFileSync(channelsFile, 'utf8')).toBe(COMMITTED);
  });

  it('appends a newly discovered channel after the existing ones', () => {
    const channels = JSON.parse(COMMITTED) as Entries;
    channels.C0 = { name: 'new', type: 'channel' };

    saveChannels(channelsFile, channels);

    const written = JSON.parse(
      fs.readFileSync(channelsFile, 'utf8'),
    ) as Entries;
    expect(Object.keys(written)).toEqual(['C1', 'D1', 'C0']);
  });

  it('surfaces a write failure to the caller', () => {
    const missing = path.join(dir, 'no-such-dir', 'channels.json');

    expect(() => {
      saveChannels(missing, { C1: { name: 'general' } });
    }).toThrow(/ENOENT/);
  });
});
