import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RateCardConfig } from './rate-card-schema.js';
import { runRefreshTokenRates } from './refresh-rates-run.js';

const CARD: RateCardConfig = {
  updatedAt: '2026-09-28T00:00:00Z',
  unit: '$/MTok',
  models: {
    'anthropic/claude-opus-5-5': {
      input: 4,
      output: 20,
      cacheRead: 0.2,
      cacheWrite: 5,
    },
  },
};

describe('runRefreshTokenRates', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('seeds, verifies, dispatches and verifies again on success', async () => {
    const calls: string[] = [];
    const result = await runRefreshTokenRates({
      ensure: () => calls.push('ensure'),
      verify: () => {
        calls.push('verify');
        return CARD;
      },
      dispatch: () => {
        calls.push('dispatch');
        return Promise.resolve({ exitCode: 0 });
      },
    });

    expect(result).toEqual({ models: 1 });
    expect(calls).toEqual(['ensure', 'verify', 'dispatch', 'verify']);
  });

  it('fails without dispatching when the rate card cannot be read', async () => {
    const dispatch = vi.fn(() => Promise.resolve({ exitCode: 0 }));
    await expect(
      runRefreshTokenRates({
        ensure: () => {},
        verify: () => {
          throw new Error('Token rate card not readable at /x: ENOENT');
        },
        dispatch,
      }),
    ).rejects.toThrow(/not readable/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('fails without dispatching when seeding fails', async () => {
    const dispatch = vi.fn(() => Promise.resolve({ exitCode: 0 }));
    await expect(
      runRefreshTokenRates({
        ensure: () => {
          throw new Error('seed missing');
        },
        verify: () => CARD,
        dispatch,
      }),
    ).rejects.toThrow(/seed missing/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('fails when the worker exits non-zero', async () => {
    await expect(
      runRefreshTokenRates({
        ensure: () => {},
        verify: () => CARD,
        dispatch: () => Promise.resolve({ exitCode: 1 }),
      }),
    ).rejects.toThrow(/exited with code 1/);
  });

  it('fails when the rate card is unreadable after the worker run', async () => {
    let n = 0;
    await expect(
      runRefreshTokenRates({
        ensure: () => {},
        verify: () => {
          n += 1;
          if (n > 1) throw new Error('not valid JSON');
          return CARD;
        },
        dispatch: () => Promise.resolve({ exitCode: 0 }),
      }),
    ).rejects.toThrow(/Rate card invalid after worker run: not valid JSON/);
  });
});
