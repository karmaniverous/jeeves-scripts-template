import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RateCardConfig } from './rate-card-schema.js';
import {
  type RefreshRatesDeps,
  refreshTokenRatesMain,
  runRefreshTokenRates,
  type WorkerRun,
} from './refresh-rates-run.js';

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
const NEWER: RateCardConfig = { ...CARD, updatedAt: '2026-09-28T05:40:00Z' };

function run(finalText: string | null, exitCode = 0): WorkerRun {
  return { exitCode, finalText };
}

/** Deps whose verify returns before, then after for every later call. */
function deps(
  worker: WorkerRun,
  before: RateCardConfig = CARD,
  after: RateCardConfig = CARD,
): RefreshRatesDeps {
  let n = 0;
  return {
    ensure: () => {},
    verify: () => (n++ === 0 ? before : after),
    dispatch: () => Promise.resolve(worker),
  };
}

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
        return Promise.resolve(run('No changes.\nRESULT: unchanged'));
      },
    });

    expect(result).toEqual({ models: 1, outcome: 'unchanged' });
    expect(calls).toEqual(['ensure', 'verify', 'dispatch', 'verify']);
  });

  it('accepts "updated" when updatedAt advanced', async () => {
    await expect(
      runRefreshTokenRates(deps(run('RESULT: updated'), CARD, NEWER)),
    ).resolves.toEqual({ models: 1, outcome: 'updated' });
  });

  it('fails "updated" when updatedAt did not advance', async () => {
    await expect(
      runRefreshTokenRates(deps(run('RESULT: updated'))),
    ).rejects.toThrow(/updatedAt did not advance/);
  });

  it('fails when the worker exits 0 but reports failure', async () => {
    await expect(
      runRefreshTokenRates(
        deps(run('I have no write tool.\nRESULT: failed: cannot write file')),
      ),
    ).rejects.toThrow(/worker failed: cannot write file/);
  });

  it.each([
    ['no final reply', null],
    ['no RESULT line', 'I could not update the rate card, sorry.'],
  ])('fails when the worker exits 0 with %s', async (_name, text) => {
    await expect(runRefreshTokenRates(deps(run(text)))).rejects.toThrow(
      /valid RESULT line/,
    );
  });

  it('fails without dispatching when the rate card cannot be read', async () => {
    const dispatch = vi.fn(() => Promise.resolve(run('RESULT: unchanged')));
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
    const dispatch = vi.fn(() => Promise.resolve(run('RESULT: unchanged')));
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
      runRefreshTokenRates(deps(run('RESULT: unchanged', 1))),
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
        dispatch: () => Promise.resolve(run('RESULT: unchanged')),
      }),
    ).rejects.toThrow(/Rate card invalid after worker run: not valid JSON/);
  });
});

describe('refreshTokenRatesMain', () => {
  it('--dry-run prints the TASK and touches nothing', async () => {
    const ensure = vi.fn();
    const verify = vi.fn(() => CARD);
    const dispatch = vi.fn(() => Promise.resolve(run('RESULT: unchanged')));
    const print = vi.fn();

    await expect(
      refreshTokenRatesMain(
        ['node', 'refresh-token-rates.ts', '--dry-run'],
        'THE TASK',
        { ensure, verify, dispatch },
        print,
      ),
    ).resolves.toBeNull();

    expect(print).toHaveBeenCalledWith('THE TASK');
    expect(ensure).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('runs the refresh without --dry-run', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const print = vi.fn();
    await expect(
      refreshTokenRatesMain(
        ['node', 'refresh-token-rates.ts'],
        'THE TASK',
        deps(run('RESULT: unchanged')),
        print,
      ),
    ).resolves.toEqual({ models: 1, outcome: 'unchanged' });
    expect(print).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
