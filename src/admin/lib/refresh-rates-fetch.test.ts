/**
 * Bounded concurrency and the overall time budget for OpenRouter fetches.
 */

import { describe, expect, it, vi } from 'vitest';

import type { ModelRates } from './rate-card-schema.js';
import { fetchAllRates } from './refresh-rates-fetch.js';

const r = (input: number, output: number): ModelRates => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
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
