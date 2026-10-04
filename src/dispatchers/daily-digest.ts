#!/usr/bin/env tsx
/**
 * @module dispatchers/daily-digest
 *
 * Dispatcher: Generate Daily Digest.
 *
 * Reads a standing-order task from `{CONTENT_DIR}/digest/TASK.md`
 * and dispatches a gateway session to execute it. The TASK.md file
 * contains the full instructions the LLM session follows each run.
 *
 * Slack is handled by this script, not the worker (OpenClaw 2026.9 workers
 * have no Slack tool): posts the TASK asks for come back in a
 * `slack-posts` block and the script posts them (see lib/worker-slack).
 * The worker may post only to the configured targets. `--dry-run` prints
 * the posts instead; `--print-task` prints the TASK.
 *
 * The TASK is prefixed with today's date in the instance's time zone, the
 * pipeline-config ref `digest.timezone` (IANA name, e.g. `America/Chicago`,
 * or `UTC`). There is no default: once TASK.md exists, a missing or invalid
 * zone fails the run.
 *
 * Prerequisites:
 * - `{CONTENT_DIR}/digest/TASK.md` must exist with your digest instructions
 * - pipeline-config ref `digest.timezone` (required once TASK.md exists)
 * - Optional pipeline-config refs: `slack.digestChannel` (channel ID to
 *   publish the digest to) and `slack.operatorDm` (user/DM ID for the
 *   completion summary). With neither set, the worker can't post to Slack.
 *
 * Register as a runner job manually (not in jobs/ manifests):
 *   runner_create_job({ id: 'generate-daily-digest', script: 'src/dispatchers/daily-digest.ts', ... })
 */

import fs from 'node:fs';
import path from 'node:path';

import { runScript } from '@karmaniverous/jeeves';

import { CONTENT_DIR } from '../lib/constants.js';
import { withDateContext } from '../lib/dates.js';
import { tryGetRef } from '../lib/pipeline-config.js';
import { dispatchWithSlack } from '../lib/worker-slack/run.js';
import type { SlackPostTarget } from '../lib/worker-slack/worker-slack-config.js';
import { digestTimeZone } from './lib/digest-timezone.js';

const taskFile = path.join(CONTENT_DIR, 'digest/TASK.md');

/** Slack targets the digest worker may post to, from pipeline-config refs. */
function digestTargets(): SlackPostTarget[] {
  const targets: SlackPostTarget[] = [];
  const channel = tryGetRef('slack.digestChannel');
  const operatorDm = tryGetRef('slack.operatorDm');
  if (channel)
    targets.push({ target: channel, purpose: 'the published daily digest' });
  if (operatorDm)
    targets.push({
      target: operatorDm,
      purpose: 'completion summary (operator DM)',
    });
  return targets;
}

runScript('dispatchers/daily-digest', async () => {
  if (!fs.existsSync(taskFile)) {
    console.log(
      `[skip] Daily digest not configured — create ${taskFile} with your digest instructions`,
    );
    return;
  }

  const task = withDateContext(
    fs.readFileSync(taskFile, 'utf8'),
    new Date(),
    digestTimeZone(),
  );

  await dispatchWithSlack(
    task,
    { jobId: 'generate-daily-digest', thinking: 'low' },
    { posts: digestTargets() },
  );
});
