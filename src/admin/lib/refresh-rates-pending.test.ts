/**
 * Pending-model discovery and manual entries in refresh-token-rates.
 */

import { describe, expect, it, vi } from 'vitest';

import { card, deps, r } from './refresh-rates-run.fixtures.js';
import {
  refreshTokenRatesMain,
  runRefreshTokenRates,
} from './refresh-rates-run.js';

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
  it('keeps an id the collector added while the run was fetching', async () => {
    const d = deps(
      card({ 'a/m': r(2, 10) }),
      { 'a/m': r(2, 10), 'a/new': r(1, 1) },
      ['a/new'],
    );
    // The collector appends 'b/late' after the run read the pending file.
    d.fetchRates = vi.fn((id: string) => {
      if (id === 'a/new') d.writePending([...d.pending(), 'b/late']);
      return Promise.resolve(id === 'a/new' ? r(1, 1) : r(2, 10));
    });
    await runRefreshTokenRates(d);
    expect(d.written[0].models['a/new']).toEqual(r(1, 1));
    expect(d.pending()).toEqual(['b/late']);
  });

  it('counts models after the refresh, including added ones', async () => {
    const d = deps(
      card({ 'a/m': r(2, 10) }),
      { 'a/m': r(2, 10), 'a/new': r(1, 1) },
      ['a/new'],
    );
    await expect(runRefreshTokenRates(d)).resolves.toMatchObject({
      models: 2,
    });
  });
});

describe('manual entries', () => {
  it('skips a manual entry: not fetched, not failed, left unchanged', async () => {
    const hand = { ...r(5, 25), manual: true };
    const d = deps(card({ 'a/m': r(2, 10), 'z/private': hand }), {
      'a/m': r(2, 10),
      'z/private': null,
    });
    await expect(runRefreshTokenRates(d)).resolves.toMatchObject({
      outcome: 'unchanged',
      models: 2,
    });
    expect(d.fetchRates).toHaveBeenCalledTimes(1);
    expect(d.fetchRates).toHaveBeenCalledWith('a/m');
  });

  it('keeps the manual flag when other models are updated', async () => {
    const hand = { ...r(5, 25), manual: true };
    const d = deps(card({ 'a/m': r(2, 10), 'z/private': hand }), {
      'a/m': r(3, 10),
    });
    await runRefreshTokenRates(d);
    expect(d.written[0].models['z/private']).toEqual(hand);
  });

  it('clears a pending id once it is added to the card by hand', async () => {
    const d = deps(
      card({ 'a/m': r(2, 10), 'z/private': { ...r(5, 25), manual: true } }),
      { 'a/m': r(2, 10) },
      ['z/private'],
    );
    await runRefreshTokenRates(d);
    expect(d.pending()).toEqual([]);
  });
});
