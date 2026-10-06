import { describe, expect, it, vi } from 'vitest';

import type { ModelRates, RateCardConfig } from './rate-card-schema.js';
import {
  fetchAllRates,
  isInternalModel,
  type RefreshRatesDeps,
  refreshTokenRatesMain,
  runRefreshTokenRates,
} from './refresh-rates-run.js';

const r = (
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
): ModelRates => ({
  input,
  output,
  cacheRead,
  cacheWrite,
});

function card(models: Record<string, ModelRates>): RateCardConfig {
  return {
    updatedAt: '2026-10-01T00:00:00Z',
    source: 'seed.',
    unit: '$/MTok',
    models,
  };
}

function deps(
  initial: RateCardConfig,
  upstream: Record<string, ModelRates | null | Error>,
  initialPending: string[] = [],
): RefreshRatesDeps & { written: RateCardConfig[]; pending: () => string[] } {
  let current = initial;
  let pending = initialPending;
  const written: RateCardConfig[] = [];
  return {
    written,
    pending: () => pending,
    readPending: vi.fn(() => pending),
    writePending: vi.fn((ids: string[]) => {
      pending = ids;
    }),
    ensure: vi.fn(),
    read: vi.fn(() => current),
    fetchRates: vi.fn((id: string) => {
      const v = upstream[id];
      if (v instanceof Error) return Promise.reject(v);
      return Promise.resolve(v ?? null);
    }),
    write: vi.fn((c: RateCardConfig) => {
      written.push(c);
      current = c;
    }),
    now: () => '2026-10-06T02:00:00.000Z',
    log: vi.fn(),
  };
}

describe('isInternalModel', () => {
  it('flags internal routing entries only', () => {
    expect(isInternalModel('openclaw/delivery-mirror')).toBe(true);
    expect(isInternalModel('clawdbot/delivery-mirror')).toBe(true);
    expect(isInternalModel('anthropic/claude-sonnet-5')).toBe(false);
  });
});

describe('runRefreshTokenRates', () => {
  it('writes nothing when all rates match', async () => {
    const d = deps(card({ 'a/m': r(2, 10, 0.2, 2.5) }), {
      'a/m': r(2, 10, 0.2, 2.5),
    });
    await expect(runRefreshTokenRates(d)).resolves.toMatchObject({
      outcome: 'unchanged',
      changes: [],
    });
    expect(d.write).not.toHaveBeenCalled();
    expect(d.ensure).toHaveBeenCalled();
  });

  it('updates changed models, advances updatedAt and notes the source', async () => {
    const d = deps(
      card({
        'o/gpt': r(4, 20, 0.4, 5),
        'a/m': r(2, 10),
        'openclaw/delivery-mirror': r(0, 0),
      }),
      { 'o/gpt': r(2, 10, 0.2, 2.5), 'a/m': r(2, 10) },
    );
    const res = await runRefreshTokenRates(d);
    expect(res.outcome).toBe('updated');
    expect(res.changes).toEqual([
      { model: 'o/gpt', before: r(4, 20, 0.4, 5), after: r(2, 10, 0.2, 2.5) },
    ]);
    expect(d.written).toHaveLength(1);
    const out = d.written[0];
    expect(out.updatedAt).toBe('2026-10-06T02:00:00.000Z');
    expect(out.models['o/gpt']).toEqual(r(2, 10, 0.2, 2.5));
    expect(out.models['openclaw/delivery-mirror']).toEqual(r(0, 0));
    expect(out.source).toContain('seed.');
    expect(out.source).toContain('OpenRouter refresh 2026-10-06: o/gpt');
    expect(d.fetchRates).not.toHaveBeenCalledWith('openclaw/delivery-mirror');
  });

  it('applies resolvable updates, then fails for unknown or erroring models', async () => {
    const d = deps(
      card({ 'a/m': r(1, 1), 'x/gone': r(1, 1), 'y/err': r(1, 1) }),
      {
        'a/m': r(2, 2),
        'x/gone': null,
        'y/err': new Error('HTTP 500'),
      },
    );
    await expect(runRefreshTokenRates(d)).rejects.toThrow(
      /could not verify 2 model\(s\): x\/gone: not found on OpenRouter; y\/err: HTTP 500/,
    );
    expect(d.written[0]?.models['a/m']).toEqual(r(2, 2));
  });

  it('fails when the card is invalid after writing', async () => {
    const d = deps(card({ 'a/m': r(1, 1) }), { 'a/m': r(2, 2) });
    d.read = vi
      .fn()
      .mockReturnValueOnce(card({ 'a/m': r(1, 1) }))
      .mockImplementationOnce(() => {
        throw new Error('bad');
      });
    await expect(runRefreshTokenRates(d)).rejects.toThrow(
      'Rate card invalid after update: bad',
    );
  });

  it('propagates a read failure before fetching anything', async () => {
    const d = deps(card({ 'a/m': r(1, 1) }), {});
    d.read = vi.fn(() => {
      throw new Error('missing');
    });
    await expect(runRefreshTokenRates(d)).rejects.toThrow('missing');
    expect(d.fetchRates).not.toHaveBeenCalled();
  });
});

describe('refreshTokenRatesMain', () => {
  it('--dry-run reports changes without seeding or writing', async () => {
    const d = deps(card({ 'a/m': r(1, 1) }), { 'a/m': r(2, 2) });
    const res = await refreshTokenRatesMain(['node', 'x', '--dry-run'], d);
    expect(res.outcome).toBe('dry-run');
    expect(res.changes).toHaveLength(1);
    expect(d.write).not.toHaveBeenCalled();
    expect(d.ensure).not.toHaveBeenCalled();
  });
});

describe('pending models', () => {
  it('adds a pending model once OpenRouter prices it and clears it', async () => {
    const d = deps(
      card({ 'a/m': r(2, 10) }),
      { 'a/m': r(2, 10), 'a/new': r(3, 15, 0.3, 3.75) },
      ['a/new'],
    );
    const res = await runRefreshTokenRates(d);
    expect(res.outcome).toBe('updated');
    expect(res.changes).toEqual([
      { model: 'a/new', before: null, after: r(3, 15, 0.3, 3.75) },
    ]);
    const out = d.written[0];
    expect(out.models['a/new']).toEqual(r(3, 15, 0.3, 3.75));
    expect(out.source).toContain('a/new added');
    expect(d.pending()).toEqual([]);
  });

  it('keeps an unresolved pending model and fails, after adding the rest', async () => {
    const d = deps(
      card({ 'a/m': r(2, 10) }),
      { 'a/m': r(2, 10), 'a/ok': r(1, 1), 'z/unknown': null },
      ['a/ok', 'z/unknown'],
    );
    await expect(runRefreshTokenRates(d)).rejects.toThrow(
      'z/unknown: not found on OpenRouter',
    );
    expect(d.written[0].models['a/ok']).toEqual(r(1, 1));
    expect(d.pending()).toEqual(['z/unknown']);
  });

  it('ignores pending ids already on the card or internal', async () => {
    const d = deps(card({ 'a/m': r(2, 10) }), { 'a/m': r(2, 10) }, [
      'a/m',
      'openclaw/delivery-mirror',
    ]);
    await expect(runRefreshTokenRates(d)).resolves.toMatchObject({
      outcome: 'unchanged',
    });
    expect(d.fetchRates).toHaveBeenCalledTimes(1);
    expect(d.pending()).toEqual([]);
  });

  it('does not touch the pending file on a dry run', async () => {
    const d = deps(
      card({ 'a/m': r(2, 10) }),
      { 'a/m': r(2, 10), 'a/new': r(1, 1) },
      ['a/new'],
    );
    const res = await refreshTokenRatesMain(['--dry-run'], d);
    expect(res.changes).toHaveLength(1);
    expect(d.writePending).not.toHaveBeenCalled();
    expect(d.pending()).toEqual(['a/new']);
  });
});

describe('fetchAllRates', () => {
  it('caps concurrent requests and preserves input order', async () => {
    let active = 0;
    let peak = 0;
    const fetchRates = vi.fn(async (id: string) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return id === 'x/none' ? null : r(1, 1);
    });
    const ids = ['a/1', 'a/2', 'a/3', 'x/none', 'a/5', 'a/6'];
    const out = await fetchAllRates(ids, fetchRates, {
      concurrency: 2,
      budgetMs: 10_000,
      clock: Date.now,
    });
    expect(peak).toBe(2);
    expect(out.map((o) => o.id)).toEqual(ids);
    expect(out[3]).toEqual({
      id: 'x/none',
      rates: null,
      problem: 'not found on OpenRouter',
    });
  });

  it('reports a fetch error as a problem', async () => {
    const out = await fetchAllRates(
      ['a/m'],
      () => Promise.reject(new Error('HTTP 502')),
      { concurrency: 4, budgetMs: 1_000, clock: Date.now },
    );
    expect(out).toEqual([{ id: 'a/m', rates: null, problem: 'HTTP 502' }]);
  });

  it('skips models not started before the budget runs out', async () => {
    let now = 0;
    const fetchRates = vi.fn(() => {
      now += 600;
      return Promise.resolve(r(1, 1));
    });
    const out = await fetchAllRates(['a/1', 'a/2', 'a/3'], fetchRates, {
      concurrency: 1,
      budgetMs: 1_000,
      clock: () => now,
    });
    expect(out.map((o) => o.rates !== null)).toEqual([true, true, false]);
    expect(out[2]).toMatchObject({
      problem: 'skipped: fetch time budget exhausted',
    });
    expect(fetchRates).toHaveBeenCalledTimes(2);
  });

  it('gives up on a request still in flight when the budget expires', async () => {
    vi.useFakeTimers();
    try {
      const pending = fetchAllRates(
        ['a/stall'],
        () => new Promise<ModelRates>(() => undefined),
        { concurrency: 4, budgetMs: 1_000, clock: Date.now },
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toEqual([
        { id: 'a/stall', rates: null, problem: 'fetch time budget exhausted' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('runRefreshTokenRates budget', () => {
  it('still writes resolved updates when another model stalls', async () => {
    vi.useFakeTimers();
    try {
      const d = deps(card({ 'a/m': r(1, 1), 'a/stall': r(1, 1) }), {
        'a/m': r(2, 2),
      });
      d.fetchRates = vi.fn((id: string) =>
        id === 'a/stall'
          ? new Promise<ModelRates>(() => undefined)
          : Promise.resolve(r(2, 2)),
      );
      const caught = runRefreshTokenRates(d).then(
        () => null,
        (err: unknown) => err,
      );
      await vi.advanceTimersByTimeAsync(60_000);
      const err = await caught;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain(
        'a/stall: fetch time budget exhausted',
      );
      expect(d.written[0].models['a/m']).toEqual(r(2, 2));
    } finally {
      vi.useRealTimers();
    }
  });
});
