/**
 * Tests for Slack read-position state in the jeeves-runner state store.
 * Uses a real runner DB (runner migrations on a temp SQLite file) and the
 * real `getRunnerClient()`: positions load from the store, a legacy
 * `lastTs` in channels.json migrates into the store before channels.json
 * is rewritten, channels.json never regains `lastTs`, an unreachable store
 * (even with no channels) or a malformed position fails loudly, positions
 * load after discovery, and absent state means "read from the beginning".
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
import { z } from 'zod';

import {
  channelEntrySchema,
  cursorKey,
  loadPollCursors,
  preparePollState,
  saveChannels,
  saveCursor,
  SLACK_STATE_NAMESPACE,
  slackTsSchema,
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
    const rewritten = z
      .record(z.string(), channelEntrySchema)
      .parse(JSON.parse(fs.readFileSync(channelsFile, 'utf8')));
    const next = loadPollCursors(client, rewritten);
    expect(next).toEqual({
      cursors: { C1: '1700000000.000100' },
      migrated: 0,
    });
  });

  it.each([
    ['with channels', { C1: { lastTs: '1700000000.000100' } }],
    ['with no channels', {}],
  ])(
    'fails clearly when the store schema is missing, %s (no silent from-beginning fallback)',
    (_label, channels) => {
      const bare = getRunnerClient(path.join(dir, 'not-a-runner-db.sqlite'));
      try {
        expect(() => loadPollCursors(bare, channels)).toThrow(
          /Slack read positions unavailable: runner state store error/,
        );
      } finally {
        bare.close();
      }
    },
  );

  it.each([
    ['with channels', { C1: {} }],
    ['with no channels', {}],
  ])('fails clearly when the store connection is gone, %s', (_l, channels) => {
    const gone = getRunnerClient(dbPath);
    gone.close();
    expect(() => loadPollCursors(gone, channels)).toThrow(
      /Slack read positions unavailable/,
    );
  });

  it('fails on a corrupt stored position instead of using it', () => {
    client.setState('slack', 'lastTs-C1', 'garbage');
    expect(() => loadPollCursors(client, { C1: {} })).toThrow(
      /Invalid Slack read position "garbage" in runner state lastTs-C1/,
    );
  });

  it.each([['1700000000'], [1700000000.0001], ['abc']])(
    'fails on a malformed legacy lastTs %j and migrates nothing',
    (lastTs) => {
      expect(() => loadPollCursors(client, { C1: { lastTs } })).toThrow(
        /Invalid Slack read position .* in channels\.json C1\.lastTs/,
      );
      expect(storedTs('C1')).toBeNull();
    },
  );
});

describe('slackTsSchema', () => {
  it.each([
    ['1700000000.000100', true],
    ['0.1', true],
    ['0', false],
    ['', false],
    ['1700000000', false],
    ['1700000000.', false],
    [' 1700000000.000100', false],
    ['1e9.1', false],
  ])('%j valid: %s', (value, ok) => {
    expect(slackTsSchema.safeParse(value).success).toBe(ok);
  });
});

describe('saveCursor', () => {
  it('writes the position to the store and overwrites on advance', () => {
    saveCursor(client, 'C1', '1700000000.000100');
    saveCursor(client, 'C1', '1700000999.000100');
    expect(storedTs('C1')).toBe('1700000999.000100');
  });

  it('fails clearly when the store is unavailable', () => {
    const gone = getRunnerClient(dbPath);
    gone.close();
    expect(() => {
      saveCursor(gone, 'C1', '1700000000.000100');
    }).toThrow(/Slack read positions unavailable/);
  });
});

describe('preparePollState', () => {
  it('loads stored positions for channels added by discovery', async () => {
    // channels.json was rebuilt; the runner DB survived.
    client.setState('slack', 'lastTs-C2', '1700000500.000200');
    const channels: Record<string, { name: string }> = { C1: { name: 'one' } };

    const result = await preparePollState(
      client,
      channelsFile,
      channels,
      () => {
        channels.C2 = { name: 'two' };
        return Promise.resolve(1);
      },
    );

    expect(result).toEqual({
      cursors: { C2: '1700000500.000200' },
      migrated: 0,
      discovered: 1,
    });
    expect(JSON.parse(fs.readFileSync(channelsFile, 'utf8'))).toEqual({
      C1: { name: 'one' },
      C2: { name: 'two' },
    });
  });

  it('migrates legacy positions and leaves channels.json alone when nothing is discovered', async () => {
    const result = await preparePollState(
      client,
      channelsFile,
      { C1: { lastTs: '1700000000.000100' } },
      () => Promise.resolve(0),
    );

    expect(result).toEqual({
      cursors: { C1: '1700000000.000100' },
      migrated: 1,
      discovered: 0,
    });
    expect(storedTs('C1')).toBe('1700000000.000100');
    expect(fs.existsSync(channelsFile)).toBe(false);
  });

  it('does not rewrite channels.json when the store is unavailable', async () => {
    const gone = getRunnerClient(dbPath);
    gone.close();
    const channels: Record<string, { lastTs?: string }> = {
      C1: { lastTs: '1700000000.000100' },
    };

    await expect(
      preparePollState(gone, channelsFile, channels, () => {
        channels.C2 = {};
        return Promise.resolve(1);
      }),
    ).rejects.toThrow(/Slack read positions unavailable/);
    expect(fs.existsSync(channelsFile)).toBe(false);
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
