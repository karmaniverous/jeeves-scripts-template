/**
 * @module google-drive/sync
 *
 * Runner entry point: mirror Google Drive content shared to the
 * configured Workspace account(s) into the content tree as text.
 * Behaviour, configuration and operations are documented in
 * `src/google-drive/README.md`; the design is
 * `docs/google-drive-spec.md` (`§` references in lib/ point there).
 *
 * Flags:
 *   --live               apply changes (default: dry run, no writes anywhere)
 *   --account <email>    limit to one configured sync; in a dry run with no
 *                        configured block, synthesizes a default entry
 *   --domains <a,b>      delegated domains for a synthesized dry-run entry
 *   --allow-mass-delete  apply deletions blocked by the mass-deletion guard
 *   --reset-state        clear the ledger + run state (requires --live)
 */

import { runScript } from '@karmaniverous/jeeves';
import {
  getRunnerClient,
  type RunnerClient,
} from '@karmaniverous/jeeves-runner';

import { CONTENT_DIR } from '../lib/constants.js';
import {
  assertDisjointTargets,
  type BudgetConfig,
  BudgetConfigSchema,
  loadGoogleDriveConfig,
  type SyncEntryConfig,
} from './lib/config.js';
import { createRunBudget } from './lib/execute.js';
import { createLedgerStore } from './lib/ledger.js';
import { runSyncs, selectSyncs } from './lib/orchestrate.js';
import { compactMeta, exitCodeFor } from './lib/summary.js';

runScript('google-drive/sync', async () => {
  const argv = process.argv.slice(2);
  const live = argv.includes('--live');
  const config = loadGoogleDriveConfig();
  const configured = config?.syncs ?? [];
  assertDisjointTargets(configured, CONTENT_DIR);
  const syncs = selectSyncs(configured, argv, live);
  if (syncs.length === 0) {
    console.log('[skip] no googleDrive syncs configured');
    return;
  }

  const runner = getRunnerClient();
  try {
    if (argv.includes('--reset-state')) {
      for (const s of syncs) {
        const n = createLedgerStore(runner, s.account, live).reset();
        console.log(
          `${live ? 'RESET' : 'WOULD RESET'} ${s.account}: ${String(n)} ledger records`,
        );
      }
      return;
    }
    await sync(runner, syncs, live, config?.budget, argv);
  } finally {
    runner.close();
  }
});

/** The sync proper: SIGTERM handling, the run budget, the run report. */
async function sync(
  runner: RunnerClient,
  syncs: SyncEntryConfig[],
  live: boolean,
  limits: BudgetConfig | undefined,
  argv: string[],
): Promise<void> {
  let stop = false;
  process.on('SIGTERM', () => {
    stop = true;
    console.log('SIGTERM: finishing the current item, then stopping');
  });

  // One budget for the whole run, on the same clock as the runner's
  // timeout (process start). A synthesized dry-run entry uses the defaults.
  const budget = createRunBudget(
    limits ?? BudgetConfigSchema.parse({}),
    Date.now() - process.uptime() * 1000,
  );

  const summaries = await runSyncs(syncs, runner, {
    live,
    allowMassDelete: argv.includes('--allow-mass-delete'),
    budget,
    shouldStop: () => stop,
    log: (account, line) => {
      console.log(`[${account}] ${line}`);
    },
  });

  console.log(`JR_RESULT:${JSON.stringify({ meta: compactMeta(summaries) })}`);
  process.exitCode = exitCodeFor(summaries);
}
