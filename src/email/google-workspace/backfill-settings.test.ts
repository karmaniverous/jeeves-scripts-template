import { describe, expect, it } from 'vitest';

import { resolveBackfillSettings } from './backfill-settings.js';

const SETTINGS = {
  accounts: ['me@example.com'],
  lookbackDays: 10,
  windowDays: 4,
};

describe('resolveBackfillSettings', () => {
  it('uses emailConfig.backfill', () => {
    expect(resolveBackfillSettings(SETTINGS, [])).toEqual(SETTINGS);
  });

  it('lets CLI args override config per field', () => {
    expect(
      resolveBackfillSettings(SETTINGS, [
        '--accounts',
        'a@example.com, b@example.com',
        '--window-days',
        '2',
      ]),
    ).toEqual({
      accounts: ['a@example.com', 'b@example.com'],
      lookbackDays: 10,
      windowDays: 2,
    });
    expect(
      resolveBackfillSettings(SETTINGS, ['--lookback-days', '30']),
    ).toEqual({ ...SETTINGS, lookbackDays: 30 });
  });

  it('works from CLI args alone', () => {
    expect(
      resolveBackfillSettings(undefined, [
        '--accounts',
        'a@example.com',
        '--lookback-days',
        '90',
        '--window-days',
        '7',
      ]),
    ).toEqual({ accounts: ['a@example.com'], lookbackDays: 90, windowDays: 7 });
  });

  it('has no defaults: missing config and args is an error', () => {
    expect(() => resolveBackfillSettings(undefined, [])).toThrow(
      /missing accounts \(--accounts\), lookbackDays \(--lookback-days\), windowDays \(--window-days\).*no defaults/,
    );
    expect(() =>
      resolveBackfillSettings(undefined, ['--accounts', 'a@example.com']),
    ).toThrow(
      /missing lookbackDays \(--lookback-days\), windowDays \(--window-days\)\./,
    );
    expect(() =>
      resolveBackfillSettings(undefined, [
        '--accounts',
        'a@example.com',
        '--lookback-days',
        '9',
      ]),
    ).toThrow(/missing windowDays \(--window-days\)\./);
  });

  it('treats an empty --accounts list as missing, even with config', () => {
    expect(() =>
      resolveBackfillSettings(SETTINGS, ['--accounts', ' , ']),
    ).toThrow(/missing accounts \(--accounts\)\./);
  });

  it('ignores a trailing flag with no value', () => {
    expect(resolveBackfillSettings(SETTINGS, ['--window-days'])).toEqual(
      SETTINGS,
    );
    expect(() => resolveBackfillSettings(undefined, ['--accounts'])).toThrow(
      /missing accounts/,
    );
  });

  it('rejects non-positive or non-integer day counts', () => {
    expect(() =>
      resolveBackfillSettings(SETTINGS, ['--window-days', '0']),
    ).toThrow(/--window-days must be a positive integer, got "0"/);
    expect(() =>
      resolveBackfillSettings(SETTINGS, ['--lookback-days', '1.5']),
    ).toThrow(/--lookback-days must be a positive integer/);
    expect(() =>
      resolveBackfillSettings(SETTINGS, ['--lookback-days', 'abc']),
    ).toThrow(/--lookback-days must be a positive integer/);
  });
});
