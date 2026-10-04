#!/usr/bin/env tsx
/**
 * @module backfill-labels
 *
 * One-shot backfill: enqueue addLabel actions for threads that have
 * classification fields but no corresponding labelApplied entries.
 *
 * Run manually as an entry-point script. Iterates all thread-state
 * entries in SQLite, checks for missing labelApplied records against
 * existing classification fields (receipt, junk, and the thread's bucket
 * when it is one of the configured `buckets` in pipeline-config), and
 * enqueues addLabel actions to `email-updates` via label-actions.ts.
 * Supports --live flag; defaults to dry-run. Enqueues nothing when
 * emailConfig.reportOnly is true.
 *
 * Depends on email-state for thread data access and pipeline-config
 * for the account list, bucket names and reportOnly.
 */

import { runScript } from '@karmaniverous/jeeves';
import { getRunnerClient } from '@karmaniverous/jeeves-runner';

import {
  getEmailAccounts,
  loadPipelineConfig,
} from '../../lib/pipeline-config.js';
import { getThreadState, seenKey, setThreadState } from '../email-state.js';
import {
  computeLabelsToApply,
  configuredBucket,
  newLabelCounts,
} from './email-triage.js';
import { enqueueLabelActions } from './label-actions.js';

function main(): void {
  const live = process.argv.includes('--live');
  const reportOnly = loadPipelineConfig().emailConfig.reportOnly;
  console.log(`Mode: ${live ? 'LIVE' : 'DRY-RUN'}\n`);
  if (live && reportOnly)
    console.log('reportOnly: no Gmail label actions enqueued\n');

  const accounts = getEmailAccounts();
  const client = getRunnerClient();

  try {
    let totalChecked = 0;
    const counts = newLabelCounts();

    for (const account of accounts) {
      const keys = client.listItemKeys('email', seenKey(account));
      console.log(`${account}: ${String(keys.length)} threads`);
      let acctLabels = 0;

      for (const tid of keys) {
        totalChecked++;
        let ts;
        try {
          ts = getThreadState(client, account, tid);
        } catch {
          // Skip old-format state items (bare ISO strings from pre-ThreadState era)
          continue;
        }
        if (!ts) continue;

        const applied = ts.labelApplied || {};
        const labelsToApply = computeLabelsToApply({
          receiptCandidate: !!ts.receiptCandidate,
          junkCandidate: !!ts.junkCandidate,
          bucket: configuredBucket(ts.bucket),
          labelApplied: applied,
        });
        if (labelsToApply.length === 0) continue;

        const r = enqueueLabelActions(client, {
          account,
          messageId:
            (ts.seenMessageIds && Object.keys(ts.seenMessageIds)[0]) || tid,
          threadId: tid,
          labels: labelsToApply,
          source: 'backfill-labels',
          reason: 'Backfill label for pre-existing classification',
          reportOnly: !live || reportOnly,
        });
        for (const lbl of labelsToApply) counts[lbl] = (counts[lbl] ?? 0) + 1;
        acctLabels += labelsToApply.length;

        if (r.enqueued > 0) {
          setThreadState(client, account, tid, {
            ...ts,
            labelApplied: { ...applied, ...r.applied },
          });
        }
      }

      console.log(`  -> ${String(acctLabels)} labels to enqueue`);
    }

    console.log('\n=== Summary ===');
    console.log(`Total threads checked: ${String(totalChecked)}`);
    console.log('Labels to enqueue by type:');
    for (const [lbl, count] of Object.entries(counts)) {
      if (count > 0) console.log(`  ${lbl}: ${String(count)}`);
    }
    if (!live) console.log('\nRe-run with --live to actually enqueue.');
  } finally {
    client.close();
  }
}

runScript('email/backfill-labels', main);
