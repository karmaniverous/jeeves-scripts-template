/**
 * @module backfill-settings
 *
 * Settings resolution for the paced historical Gmail backfill
 * (email/google-workspace/backfill-historical.ts).
 *
 * There are NO default accounts, lookback, or window: they come from
 * `emailConfig.backfill` in pipeline-config.json or CLI args
 * (`--accounts a,b`, `--lookback-days N`, `--window-days N`), and any
 * value missing from both is an error.
 *
 * Called by email/google-workspace/backfill-historical.ts.
 */

import { z } from 'zod';

import type { BackfillConfig } from '../../lib/pipeline-config.js';

/** Resolved backfill settings. */
export interface BackfillSettings {
  accounts: string[];
  lookbackDays: number;
  windowDays: number;
}

const positiveInt = z.coerce.number().int().positive();

function argValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

function parseDays(raw: string, flag: string): number {
  const parsed = positiveInt.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${flag} must be a positive integer, got "${raw}"`);
  }
  return parsed.data;
}

function parseAccounts(raw: string): string[] {
  return raw
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
}

/**
 * Resolve settings from CLI args (`--accounts a,b`, `--lookback-days N`,
 * `--window-days N`), falling back per field to `emailConfig.backfill`.
 *
 * @throws When any field is missing from both, or invalid.
 */
export function resolveBackfillSettings(
  config: BackfillConfig | undefined,
  argv: string[],
): BackfillSettings {
  const accountsArg = argValue(argv, '--accounts');
  const lookbackArg = argValue(argv, '--lookback-days');
  const windowArg = argValue(argv, '--window-days');

  const accounts =
    accountsArg !== undefined ? parseAccounts(accountsArg) : config?.accounts;
  const lookbackDays =
    lookbackArg !== undefined
      ? parseDays(lookbackArg, '--lookback-days')
      : config?.lookbackDays;
  const windowDays =
    windowArg !== undefined
      ? parseDays(windowArg, '--window-days')
      : config?.windowDays;

  if (
    accounts === undefined ||
    accounts.length === 0 ||
    lookbackDays === undefined ||
    windowDays === undefined
  ) {
    const missing = [
      ...(accounts?.length ? [] : ['accounts (--accounts)']),
      ...(lookbackDays === undefined ? ['lookbackDays (--lookback-days)'] : []),
      ...(windowDays === undefined ? ['windowDays (--window-days)'] : []),
    ];
    throw new Error(
      `email/backfill-historical: missing ${missing.join(', ')}. ` +
        'Set emailConfig.backfill in pipeline-config.json or pass the CLI args; there are no defaults.',
    );
  }
  return { accounts, lookbackDays, windowDays };
}
