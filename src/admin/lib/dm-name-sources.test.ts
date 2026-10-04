/**
 * Tests for the DM-name adapters: cache and Slack user-map parsing, the
 * gateway member-info lookup (name preference, failure and timeout), and
 * applyDmNames writing only learned names (never on dry runs).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HourlyBucket } from '../types/token-metrics.js';
import {
  applyDmNames,
  gatewayMemberName,
  loadSlackUserNames,
  readDmNameCache,
} from './dm-name-sources.js';

let dir: string;
const file = (name: string, value: unknown) => {
  const fp = path.join(dir, name);
  fs.writeFileSync(
    fp,
    typeof value === 'string' ? value : JSON.stringify(value),
  );
  return fp;
};

const member = (user: Record<string, unknown>) =>
  Promise.resolve({ details: { ok: true, info: { ok: true, user } } });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-names-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readDmNameCache / loadSlackUserNames', () => {
  it('reads valid files and treats missing or invalid ones as empty', () => {
    expect(readDmNameCache(file('c.json', { U1: 'A B' }))).toEqual({
      U1: 'A B',
    });
    expect(readDmNameCache(path.join(dir, 'missing.json'))).toEqual({});
    expect(readDmNameCache(file('bad.json', '{nope'))).toEqual({});
    expect(
      loadSlackUserNames(
        file('users.json', {
          U1: { alias: 'Alias One', name: 'one', is_bot: false, emails: [] },
          U2: { name: 'two' },
          U3: 'Three',
          U4: { emails: [] },
        }),
      ),
    ).toEqual({ U1: 'Alias One', U2: 'two', U3: 'Three' });
  });
});

describe('gatewayMemberName', () => {
  it('prefers the real name and calls the message tool member-info action', async () => {
    const invoke = vi.fn(() =>
      member({
        name: 'justin',
        profile: { real_name: 'Justin Ragsdale', display_name: 'JR' },
      }),
    );
    expect(await gatewayMemberName('U000EXAMPLE1', invoke)).toBe(
      'Justin Ragsdale',
    );
    expect(invoke).toHaveBeenCalledWith('message', {
      action: 'member-info',
      channel: 'slack',
      userId: 'U000EXAMPLE1',
    });
    expect(
      await gatewayMemberName('U1', () => member({ name: 'handle' })),
    ).toBe('handle');
  });

  it('returns undefined on failure, bad shape or timeout', async () => {
    expect(
      await gatewayMemberName('U1', () => Promise.reject(new Error('down'))),
    ).toBeUndefined();
    expect(
      await gatewayMemberName('U1', () => Promise.resolve({ nope: 1 })),
    ).toBeUndefined();
    expect(
      await gatewayMemberName('U1', () => new Promise(() => undefined), 10),
    ).toBeUndefined();
  });
});

describe('applyDmNames', () => {
  const buckets = (): Map<string, HourlyBucket> =>
    new Map([
      [
        'h',
        {
          hour: 'h',
          channels: {
            'slack:dm:U000EXAMPLE1': {
              models: {
                m: {
                  input: { count: 1, cost: 1 },
                  output: { count: 0, cost: 0 },
                  cacheRead: { count: 0, cost: 0 },
                  cacheWrite: { count: 0, cost: 0 },
                },
              },
            },
          },
        },
      ],
    ]);

  it('renames, caches learned names, and reuses the cache next time', async () => {
    const cachePath = path.join(dir, 'slack-dm-names.json');
    const usersPath = path.join(dir, 'users.json');
    const lookup = vi.fn(() => Promise.resolve('Justin Ragsdale'));
    const b = buckets();

    expect(await applyDmNames(b, { cachePath, usersPath, lookup })).toBe(1);
    expect(Object.keys(b.get('h')?.channels ?? {})).toEqual([
      'slack:dm:justin-ragsdale',
    ]);
    expect(readDmNameCache(cachePath)).toEqual({
      U000EXAMPLE1: 'Justin Ragsdale',
    });

    await applyDmNames(buckets(), { cachePath, usersPath, lookup });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('dry run renames in memory but never writes the cache', async () => {
    const cachePath = path.join(dir, 'slack-dm-names.json');
    await applyDmNames(buckets(), {
      cachePath,
      usersPath: path.join(dir, 'users.json'),
      lookup: () => Promise.resolve('Justin Ragsdale'),
      dryRun: true,
    });
    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it('keeps the id key when nothing resolves', async () => {
    const b = buckets();
    await applyDmNames(b, {
      cachePath: path.join(dir, 'c.json'),
      usersPath: path.join(dir, 'u.json'),
    });
    expect(Object.keys(b.get('h')?.channels ?? {})).toEqual([
      'slack:dm:U000EXAMPLE1',
    ]);
  });
});
