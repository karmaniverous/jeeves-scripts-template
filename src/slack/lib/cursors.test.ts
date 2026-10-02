/**
 * Tests for Slack read-position state in the jeeves-runner state store.
 * Uses a real runner DB (runner migrations on a temp SQLite file) and the
 * real `getRunnerClient()`: positions load from the store, a legacy
 * `lastTs` in channels.json migrates into the store before channels.json
 * is rewritten, channels.json never regains `lastTs`, an unreachable store
 * fails loudly, and absent state means "read from the beginning".
 *
 * @module slack/lib/cursors.test
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  closeConnection,
  createConnection,
  getRunnerClient,
  runMigrations,
  type RunnerClient,
} from '@karmaniverous/jeeves-runner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cursorKey,
  loadPollCursors,
  saveChannels,
  saveCursor,
  SLACK_STATE_NAMESPACE,
} from './cursors.js';

let dir: string;
let dbPath: string;
let channelsFile: string;
let client: RunnerClient;

/** Read a stored position through an independent connection. */
function storedTs(channelId: string): string | null {
  const other = getRunnerClient(dbPath);
  try {
    return other.getState(SLACK_STATE_NAMESPACE, cursorKey(channelId));
  } finally {
    other.close();
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-cursors-'));
  dbPath = path.join(dir, 'runner.sqlite');
  channelsFile = path.join(dir, 'channels.json');
  const db = createConnection(dbPath);
  runMigrations(db);
  closeConnection(db);
  client = getRunnerClient(dbPath);
});

afterEach(() => {
  client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadPollCursors', () => {
  it('reads positions from the runner store (slack / lastTs-<channelId>)', () => {
    client.setState('slack', 'lastTs-C1', '1700000000.000100');
    client.setState('slack', 'lastTs-C2', '1700000500.000200');

    const { cursors, migrated } = loadPollCursors(client, {
      C1: { name: 'one' },
      C2: { name: 'two' },
    });

    expect(cursors).toEqual({
      C1: '1700000000.000100',
      C2: '1700000500.000200',
    });
    expect(migrated).toBe(0);
  });

  it('absent state and no legacy value: channel is read from the beginning', () => {
    const { cursors, migrated } = loadPollCursors(client, {
      C1: {},
      C2: { lastTs: '0' },
      C3: { lastTs: '' },
    });

    expect(cursors).toEqual({});
    expect(migrated).toBe(0);
    // Nothing is invented in the store either.
    expect(storedTs('C1')).toBeNull();
    expect(storedTs('C2')).toBeNull();
  });

  it('prefers the stored position over a legacy channels.json lastTs', () => {
    client.setState('slack', 'lastTs-C1', '1700000900.000000');

    const { cursors, migrated } = loadPollCursors(client, {
      C1: { lastTs: '1600000000.000000' },
    });

    expect(cursors).toEqual({ C1: '1700000900.000000' });
    expect(migrated).toBe(0);
    expect(storedTs('C1')).toBe('1700000900.000000');
  });

  it('migrates a legacy lastTs into the store before channels.json is rewritten', () => {
    const legacy = {
      C1: { name: 'one', lastTs: '1700000000.000100' },
      C2: { name: 'two', lastTs: '0' },
    };
    fs.writeFileSync(channelsFile, JSON.stringify(legacy), 'utf8');

    const { cursors, migrated } = loadPollCursors(client, legacy);

    expect(migrated).toBe(1);
    expect(cursors).toEqual({ C1: '1700000000.000100' });
    // Durable in the store (visible to a separate connection) while
    // channels.json is still untouched: loading alone never rewrites it.
    expect(storedTs('C1')).toBe('1700000000.000100');
    expect(fs.readFileSync(channelsFile, 'utf8')).toBe(JSON.stringify(legacy));

    // channels.json rewritten without lastTs; the next run resumes from the store.
    saveChannels(channelsFile, legacy);
    const rewritten = JSON.parse(
      fs.readFileSync(channelsFile, 'utf8'),
    ) as Record<string, { name?: string }>;
    const next = loadPollCursors(client, rewritten);
    expect(next).toEqual({
      cursors: { C1: '1700000000.000100' },
      migrated: 0,
    });
  });

  it('fails clearly when the store schema is missing (no silent from-beginning fallback)', () => {
    const bare = getRunnerClient(path.join(dir, 'not-a-runner-db.sqlite'));
    try {
      expect(() =>
        loadPollCursors(bare, { C1: { lastTs: '1700000000.000100' } }),
      ).toThrow(/Slack read positions unavailable: runner state store error/);
    } finally {
      bare.close();
    }
  });

  it('fails clearly when the store connection is gone', () => {
    const gone = getRunnerClient(dbPath);
    gone.close();
    expect(() => loadPollCursors(gone, { C1: {} })).toThrow(
      /Slack read positions unavailable/,
    );
  });
});

describe('saveCursor', () => {
  it('writes the position to the store and overwrites on advance', () => {
    saveCursor(client, 'C1', '1700000000.000100');
    saveCursor(client, 'C1', '1700000999.000100');
    expect(storedTs('C1')).toBe('1700000999.000100');
  });
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
});
