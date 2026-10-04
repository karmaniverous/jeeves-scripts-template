#!/usr/bin/env tsx
/**
 * @module backfill-historical
 *
 * Paced historical Gmail backfill: each run searches ONE window per
 * account (all result pages), walking back from the newest unprocessed
 * point until the lookback limit, then no-ops. New threads are
 * classified, fetched (enqueued for download) and, unless
 * `emailConfig.reportOnly`, label actions are enqueued.
 *
 * Settings come from `emailConfig.backfill` in pipeline-config.json
 * (`accounts`, `lookbackDays`, `windowDays`), overridable per field with
 * `--accounts a,b`, `--lookback-days N`, `--window-days N`. There are no
 * defaults: missing settings fail the run.
 *
 * Dry-run by default (searches and reports, writes nothing and does not
 * move the cursor). `--live` processes and advances the cursor; the
 * runner job (`jobs/email.json`, `email-backfill-historical`) passes it.
 *
 * Cursor: runner state namespace `email-backfill`, key `cursor-<email>`.
 * See backfill-window.ts.
 */

import { ensureDir, runScript } from '@karmaniverous/jeeves';
import { getRunnerClient } from '@karmaniverous/jeeves-runner';

import { EMAIL_EVENTS_DIR } from '../../lib/constants.js';
import { gogWithRetry } from '../../lib/gog.js';
import { requireGogCredentials } from '../../lib/gog-credentials.js';
import { loadPipelineConfig } from '../../lib/pipeline-config.js';
import { backfillAccount, resolveBackfillSettings } from './backfill-window.js';

function main(): void {
  const live = process.argv.includes('--live');
  const { emailConfig } = loadPipelineConfig();
  const settings = resolveBackfillSettings(emailConfig.backfill, process.argv);
  const reportOnly = emailConfig.reportOnly;

  console.log(`Mode: ${live ? 'LIVE' : 'DRY-RUN'}`);
  console.log(`Accounts: ${settings.accounts.join(', ')}`);
  console.log(
    `Lookback: ${String(settings.lookbackDays)} days, window: ${String(settings.windowDays)} days`,
  );
  if (reportOnly) console.log('reportOnly: no Gmail label actions enqueued');

  requireGogCredentials('email/backfill-historical', settings.accounts.length);

  const client = getRunnerClient();
  try {
    ensureDir(EMAIL_EVENTS_DIR);
    const now = new Date();

    for (const account of settings.accounts) {
      console.log(`--- ${account} ---`);
      const r = backfillAccount(account, settings, {
        client,
        gog: (args) => gogWithRetry(args, { retries: 2, backoffMs: 5000 }),
        now,
        live,
        reportOnly,
      });
      if (!r.window) {
        console.log('  Lookback limit reached: nothing to do');
        continue;
      }
      console.log(
        `  Window:        ${r.window.after.toISOString()} .. ${r.window.before.toISOString()}`,
      );
      console.log(`  Found:         ${String(r.found)}`);
      console.log(`  Already known: ${String(r.known)}`);
      console.log(`  New:           ${String(r.new)}`);
      console.log(
        `  Labels:        ${String(r.labelsEnqueued)} enqueued / ${String(r.labelsPlanned)} planned`,
      );
      if (r.cursorAdvancedTo) {
        console.log(`  Cursor:        ${r.cursorAdvancedTo}`);
      }
    }
    if (!live) console.log('\nRe-run with --live to process and advance.');
  } finally {
    client.close();
  }
}

runScript('email/backfill-historical', main, EMAIL_EVENTS_DIR);
