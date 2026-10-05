/**
 * @module google-drive/lib/orchestrate
 *
 * Multi-sync orchestration behind the CLI: pick the syncs to run from
 * config and flags, run them oldest-last-run first (so none starves
 * under the shared budget), and record each one's run state.
 */

import { getArg } from '@karmaniverous/jeeves';
import type { RunnerClient } from '@karmaniverous/jeeves-runner';

import { type SyncEntryConfig, SyncEntrySchema } from './config.js';
import { budgetExhausted } from './execute.js';
import { createLedgerStore } from './ledger.js';
import { syncOne, type SyncOptions } from './run-sync.js';
import type { SyncSummary } from './summary.js';

/**
 * Configured syncs, filtered by `--account`. In a dry run, an
 * unconfigured `--account` synthesizes a default entry (delegated domain
 * = the account's domain unless `--domains` says otherwise).
 */
export function selectSyncs(
  configured: SyncEntryConfig[],
  argv: string[],
  live: boolean,
): SyncEntryConfig[] {
  const account = getArg(argv, '--account', '').toLowerCase();
  if (!account) return configured;
  const matched = configured.filter((s) => s.account.toLowerCase() === account);
  if (matched.length > 0 || live) return matched;
  const domains = getArg(argv, '--domains', account.split('@')[1] ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
  return [SyncEntrySchema.parse({ account, pathResolution: { domains } })];
}

/** `lastRunAt` from a saved run state, or '' (never run sorts first). */
export function lastRunAt(state: unknown): string {
  if (state && typeof state === 'object' && 'lastRunAt' in state) {
    return String(state.lastRunAt);
  }
  return '';
}

export type RunOptions = Omit<SyncOptions, 'log'> & {
  log: (account: string, line: string) => void;
};

/** Run every sync, oldest last run first; save each run state as it finishes. */
export async function runSyncs(
  syncs: SyncEntryConfig[],
  runner: RunnerClient,
  opts: RunOptions,
  syncFn: typeof syncOne = syncOne,
): Promise<SyncSummary[]> {
  const entries = syncs
    .map((cfg) => {
      const store = createLedgerStore(runner, cfg.account, opts.live);
      return { cfg, store, at: lastRunAt(store.loadRunState()) };
    })
    .sort((a, b) => a.at.localeCompare(b.at));

  const summaries: SyncSummary[] = [];
  for (const { cfg, store } of entries) {
    // Out of budget: leave the remaining accounts' lastRunAt untouched so
    // they sort first next run instead of starving behind this one.
    if (opts.live && (opts.shouldStop() || budgetExhausted(opts.budget))) break;
    const summary = await syncFn(cfg, runner, {
      ...opts,
      log: (line) => {
        opts.log(cfg.account, line);
      },
    });
    summaries.push(summary);
    store.saveRunState({ ...summary, lastRunAt: new Date().toISOString() });
  }
  return summaries;
}
