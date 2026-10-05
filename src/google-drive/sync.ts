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
import { getRunnerClient } from '@karmaniverous/jeeves-runner';

import { CONTENT_DIR } from '../lib/constants.js';
import { getGoogleDriveSyncs } from '../lib/pipeline-config.js';
import { assertDisjointTargets } from './lib/config.js';
import { createLedgerStore } from './lib/ledger.js';
import { runSyncs, selectSyncs } from './lib/orchestrate.js';
import { compactMeta, exitCodeFor } from './lib/summary.js';

runScript('google-drive/sync', async () => {
  const argv = process.argv.slice(2);
  const live = argv.includes('--live');
  const configured = getGoogleDriveSyncs();
  assertDisjointTargets(configured, CONTENT_DIR);
  const syncs = selectSyncs(configured, argv, live);
  if (syncs.length === 0) {
    console.log('[skip] no googleDrive syncs configured');
    return;
  }

  const runner = getRunnerClient();

  if (argv.includes('--reset-state')) {
    for (const s of syncs) {
      const n = createLedgerStore(runner, s.account, live).reset();
      console.log(
        `${live ? 'RESET' : 'WOULD RESET'} ${s.account}: ${String(n)} ledger records`,
      );
    }
    return;
  }

  let stop = false;
  process.on('SIGTERM', () => {
    stop = true;
    console.log('SIGTERM: finishing the current item, then stopping');
  });

  // The budget runs from process start, the same clock as the runner's timeout.
  const started = Date.now() - process.uptime() * 1000;
  const maxSeconds = Math.min(...syncs.map((s) => s.budget.maxSeconds));

  const summaries = await runSyncs(syncs, runner, {
    live,
    allowMassDelete: argv.includes('--allow-mass-delete'),
    deadline: started + maxSeconds * 1000,
    shouldStop: () => stop,
    log: (account, line) => {
      console.log(`[${account}] ${line}`);
    },
  });

  console.log(`JR_RESULT:${JSON.stringify({ meta: compactMeta(summaries) })}`);
  process.exitCode = exitCodeFor(summaries);
});
