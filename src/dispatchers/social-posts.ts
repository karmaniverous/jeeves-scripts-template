#!/usr/bin/env tsx
/**
 * @module dispatchers/social-posts
 *
 * Dispatcher: Generate Social Posts.
 *
 * Builds a social-post generation task from pipeline-config refs and
 * content paths, then dispatches a gateway session to execute it.
 *
 * This is an example dispatcher — customize the task template in
 * {@link buildTask} for your instance's content sources, post targets,
 * and editorial rules.
 *
 * Slack is handled by this script, not the worker (OpenClaw 2026.9 workers
 * have no Slack tool): the worker returns its summary posts in a
 * `slack-posts` block and the script posts them (see lib/worker-slack).
 * `--dry-run` prints the posts instead; `--print-task` prints the TASK.
 *
 * Prerequisites (all via pipeline-config.json refs):
 * - `notion.socialPostsDatabaseId` — Notion database to write posts to
 * - `slack.socialChannel` — Slack channel ID for posting summaries
 * - `slack.operatorDm` — Slack user or DM channel ID for completion routing
 *
 * Register as a runner job manually (not in jobs/ manifests):
 *   runner_create_job({ id: 'generate-social-posts', script: 'src/dispatchers/social-posts.ts', ... })
 */

import path from 'node:path';

import { runScript } from '@karmaniverous/jeeves';

import { CONTENT_DIR } from '../lib/constants.js';
import { tryGetRef } from '../lib/pipeline-config.js';
import { dispatchWithSlack } from '../lib/worker-slack/run.js';
import type { WorkerSlackConfig } from '../lib/worker-slack/worker-slack-config.js';

const JOB_ID = 'generate-social-posts';

function buildTask(): { task: string; slack: WorkerSlackConfig } {
  const notionDb = tryGetRef('notion.socialPostsDatabaseId');
  const socialChannel = tryGetRef('slack.socialChannel');
  const operatorDm = tryGetRef('slack.operatorDm');

  if (!notionDb || !socialChannel || !operatorDm) {
    throw new Error(
      'Missing required pipeline-config refs: notion.socialPostsDatabaseId, slack.socialChannel, slack.operatorDm',
    );
  }

  const xDir = path.join(CONTENT_DIR, 'x');
  const githubDir = path.join(CONTENT_DIR, 'github');
  const emailDir = path.join(CONTENT_DIR, 'email');
  const globalDir = path.join(CONTENT_DIR, 'global');

  // Customize this task template for your instance's editorial rules,
  // content sources, post targets, and volume requirements.
  const task = `Generate social media content.

Read:
- ${path.join(xDir, 'blotter.md')} (PRIMARY — your editorial blotter)
- ${path.join(githubDir, 'meta-summary.md')}, ${path.join(xDir, '.meta/meta.json')}, ${path.join(emailDir, '.meta/meta.json')}, ${path.join(globalDir, 'digest')}, ${path.join(globalDir, 'summary.md')}

Write to Notion DB ${notionDb}.

Generate posts based on your editorial direction in the blotter.

LINK VERIFICATION: NEVER include unverified links. Use web_fetch to confirm.

Then return a summary of the generated posts for the social channel (${socialChannel}) and a completion summary for the operator DM (${operatorDm}) as Slack posts (see the Slack section below).`;

  return {
    task,
    slack: {
      posts: [
        {
          target: socialChannel,
          purpose: 'summary of the posts you generated',
        },
        {
          target: operatorDm,
          purpose: 'your completion summary (operator DM)',
        },
      ],
    },
  };
}

runScript('dispatchers/social-posts', async () => {
  const notionDb = tryGetRef('notion.socialPostsDatabaseId');
  if (!notionDb) {
    console.log(
      '[skip] Social posts dispatcher not configured — set notion.socialPostsDatabaseId in pipeline-config.json',
    );
    return;
  }

  const { task, slack } = buildTask();
  await dispatchWithSlack(task, { jobId: JOB_ID, thinking: 'low' }, slack);
});
