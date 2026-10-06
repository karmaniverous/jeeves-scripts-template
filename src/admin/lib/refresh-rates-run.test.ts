import { describe, expect, it, vi } from 'vitest';

import type { ModelRates } from './rate-card-schema.js';
import { card, deps, r } from './refresh-rates-run.fixtures.js';
import {
  isInternalModel,
  refreshTokenRatesMain,
  runRefreshTokenRates,
} from './refresh-rates-run.js';

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
