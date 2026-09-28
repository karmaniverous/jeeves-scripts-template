/**
 * Tests for Slack DM naming: id-only DM keys resolved via cache, user map
 * and live lookup (in that order), failures falling back to the id, and
 * renaming that merges into an existing entry for the same person.
 */

import { describe, expect, it, vi } from 'vitest';

import type { HourlyBucket, HourlyModelEntry } from '../types/token-metrics.js';
import { dmUserIds, renameDmChannels, resolveDmNames } from './dm-names.js';

const entry = (input: number): HourlyModelEntry => ({
  input: { count: input, cost: input / 10 },
  output: { count: 0, cost: 0 },
  cacheRead: { count: 0, cost: 0 },
  cacheWrite: { count: 0, cost: 0 },
});

function buckets(): Map<string, HourlyBucket> {
  return new Map<string, HourlyBucket>([
    [
      'h1',
      {
        hour: 'h1',
        channels: {
          'slack:dm:U0B2YNF9MF1': { models: { m: entry(5), n: entry(1) } },
          'slack:dm:justin-ragsdale': { models: { m: entry(2) } },
          'slack:dm:W0ENTERPRISE': { models: { m: entry(7) } },
          'slack:dm:bob': { models: { m: entry(3) } },
          'slack:channel:#ops': { models: { m: entry(4) } },
        },
      },
    ],
    [
      'h2',
      {
        hour: 'h2',
        channels: { 'slack:dm:U0UNKNOWN1': { models: { m: entry(9) } } },
      },
    ],
  ]);
}

describe('dmUserIds', () => {
  it('finds only upper-case user-id DM keys', () => {
    expect(dmUserIds(buckets())).toEqual([
      'U0B2YNF9MF1',
      'U0UNKNOWN1',
      'W0ENTERPRISE',
    ]);
  });
});

describe('resolveDmNames', () => {
  it('uses cache, then user map, then the live lookup; failures stay unresolved', async () => {
    const lookup = vi.fn((id: string) =>
      id === 'W0ENTERPRISE'
        ? Promise.resolve('Ent User')
        : Promise.reject(new Error('gateway down')),
    );
    const { names, learned } = await resolveDmNames(
      ['U0B2YNF9MF1', 'U0MAPPED01', 'U0UNKNOWN1', 'W0ENTERPRISE'],
      {
        cache: { U0B2YNF9MF1: 'Justin Ragsdale' },
        userMap: { U0MAPPED01: 'Mapped Person' },
        lookup,
      },
    );

    expect(Object.fromEntries(names)).toEqual({
      U0B2YNF9MF1: 'Justin Ragsdale',
      U0MAPPED01: 'Mapped Person',
      W0ENTERPRISE: 'Ent User',
    });
    expect(learned).toEqual({ W0ENTERPRISE: 'Ent User' });
    expect(lookup.mock.calls.map((c) => c[0])).toEqual([
      'U0UNKNOWN1',
      'W0ENTERPRISE',
    ]);
  });

  it('ignores names that slugify to nothing', async () => {
    const { names } = await resolveDmNames(['U0B2YNF9MF1'], {
      cache: {},
      userMap: {},
      lookup: () => Promise.resolve('   ??? '),
    });
    expect(names.size).toBe(0);
  });
});

describe('renameDmChannels', () => {
  it('renames id keys to person slugs, merging with an existing entry', () => {
    const b = buckets();
    const renamed = renameDmChannels(
      b,
      new Map([
        ['U0B2YNF9MF1', 'Justin Ragsdale'],
        ['W0ENTERPRISE', 'Ent User'],
      ]),
    );

    expect(renamed).toBe(2);
    const h1 = b.get('h1')?.channels ?? {};
    expect(Object.keys(h1).sort()).toEqual([
      'slack:channel:#ops',
      'slack:dm:bob',
      'slack:dm:ent-user',
      'slack:dm:justin-ragsdale',
    ]);
    expect(h1['slack:dm:justin-ragsdale'].models.m.input).toEqual({
      count: 7,
      cost: 0.7,
    });
    expect(h1['slack:dm:justin-ragsdale'].models.n.input.count).toBe(1);
    expect(Object.keys(b.get('h2')?.channels ?? {})).toEqual([
      'slack:dm:U0UNKNOWN1',
    ]);
  });
});
