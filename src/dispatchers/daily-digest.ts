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
 * Prerequisites:
 * - `{CONTENT_DIR}/digest/TASK.md` must exist with your digest instructions
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
import { tryGetRef } from '../lib/pipeline-config.js';
import { dispatchWithSlack } from '../lib/worker-slack/run.js';
import type { SlackPostTarget } from '../lib/worker-slack/worker-slack-config.js';

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

  let task = fs.readFileSync(taskFile, 'utf8');

  const tz = 'UTC';
  const now = new Date();
  const dayName = now.toLocaleDateString('en-US', {
    weekday: 'long',
    timeZone: tz,
  });
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: tz });
  task =
    `> **Today is ${dayName}, ${dateStr} (${tz}).** Use this as the authoritative date reference for all dates in this report.\n\n` +
    task;

  await dispatchWithSlack(
    task,
    { jobId: 'generate-daily-digest', thinking: 'low' },
    { posts: digestTargets() },
  );
});
