/**
 * @module worker-slack/worker-slack-job
 *
 * Job-side Slack orchestration for LLM worker dispatches (OpenClaw 2026.9:
 * workers have no Slack tool). Side effects are injected so the flow is
 * testable with a mocked messaging layer:
 *
 * 1. read the configured channels/threads and append them to the TASK;
 * 2. append the Slack output contract (worker-posts.ts);
 * 3. dispatch the worker (skipped with `printTask`);
 * 4. parse and validate the worker's `slack-posts` block;
 * 5. post each message (pin it, or edit an existing message, when asked),
 *    or print the posts in `dryRun` mode.
 *
 * Nothing is posted unless the whole block is valid and every target is
 * allowed.
 */

import type { SlackIo } from './slack-io.js';
import { requireSlackTarget } from './slack-target.js';
import {
  formatSlackContext,
  parseWorkerPosts,
  type SlackContextBlock,
  slackOutputInstructions,
  type WorkerPost,
} from './worker-posts.js';

/** A Slack read made before dispatch. */
export interface SlackReadSpec {
  /** Channel/user id or prefixed target. */
  target: string;
  /** Label shown to the worker, e.g. `#ops-ceo`. */
  label: string;
  /** Messages to read (default 20). */
  limit?: number;
  /** Read this thread instead of the channel. */
  threadTs?: string;
}

/** A target the worker may post to. */
export interface SlackPostTarget {
  /** Channel/user id or prefixed target. */
  target: string;
  /** What posts there are for (shown to the worker). */
  purpose: string;
}

/** Slack configuration for one job. */
export interface WorkerSlackConfig {
  /** Gateway Slack account id (multi-account gateways, e.g. `vc`). */
  accountId?: string;
  /** Reads made before dispatch. */
  reads?: SlackReadSpec[];
  /** Targets the worker may post to. */
  posts?: SlackPostTarget[];
}

/** Injected side effects and flags. */
export interface WorkerSlackDeps {
  /** Messaging layer. */
  slack: SlackIo;
  /** Dispatch the worker; resolves to its exit code and final reply. */
  dispatch: (
    task: string,
  ) => Promise<{ exitCode: number; finalText: string | null }>;
  /** Print instead of posting. */
  dryRun?: boolean;
  /** Print the TASK and stop before dispatching. */
  printTask?: boolean;
  /** Output sink (default console.log). */
  print?: (text: string) => void;
}

/** Outcome of {@link runWorkerSlackJob}. */
export interface WorkerSlackResult {
  /** The full TASK that was (or would be) dispatched. */
  task: string;
  /** Validated posts (empty when printTask). */
  posts: WorkerPost[];
  /** Number of messages actually posted. */
  posted: number;
}

/**
 * Build the TASK: base task + Slack context + Slack output contract.
 *
 * @param baseTask - Job TASK text.
 * @param config - Job Slack configuration.
 * @param slack - Messaging layer used for the reads.
 * @returns The full TASK.
 */
export async function buildWorkerSlackTask(
  baseTask: string,
  config: WorkerSlackConfig,
  slack: SlackIo,
): Promise<string> {
  const blocks: SlackContextBlock[] = [];
  for (const r of config.reads ?? []) {
    const target = requireSlackTarget(r.target);
    const messages = await slack.read(target, {
      limit: r.limit ?? 20,
      threadTs: r.threadTs,
    });
    const where = r.threadTs ? `${r.label} thread ${r.threadTs}` : r.label;
    blocks.push({ label: `${where} [${target}]`, messages });
  }
  const posts = (config.posts ?? []).map((p) => ({
    target: requireSlackTarget(p.target),
    purpose: p.purpose,
  }));
  return [
    baseTask.trimEnd(),
    formatSlackContext(blocks),
    slackOutputInstructions(posts),
  ]
    .filter((s) => s.length > 0)
    .join('\n\n');
}

function describe(post: WorkerPost): string {
  const where = post.edit_ts
    ? `${post.channel} edit ${post.edit_ts}`
    : post.thread_ts
      ? `${post.channel} thread ${post.thread_ts}`
      : post.channel;
  return `[slack dry-run] → ${where}${post.pin ? ' (pin)' : ''}\n${post.text}`;
}

async function deliver(slack: SlackIo, post: WorkerPost): Promise<void> {
  if (post.edit_ts) {
    await slack.edit(post.channel, post.edit_ts, post.text);
    return;
  }
  const ts = await slack.send(post.channel, post.text, post.thread_ts);
  if (!post.pin) return;
  if (!ts)
    throw new Error(`Posted to ${post.channel} but got no message ts to pin`);
  await slack.pin(post.channel, ts);
}

/**
 * Run one worker job with job-side Slack I/O.
 *
 * @param baseTask - Job TASK text (must not ask the worker to call Slack).
 * @param config - Reads and allowed post targets.
 * @param deps - Injected side effects and flags.
 * @returns The TASK, validated posts, and how many were posted.
 * @throws Error when a read, dispatch, validation or post fails.
 */
export async function runWorkerSlackJob(
  baseTask: string,
  config: WorkerSlackConfig,
  deps: WorkerSlackDeps,
): Promise<WorkerSlackResult> {
  const print = deps.print ?? console.log;
  const task = await buildWorkerSlackTask(baseTask, config, deps.slack);
  if (deps.printTask) {
    print(task);
    return { task, posts: [], posted: 0 };
  }

  const { exitCode, finalText } = await deps.dispatch(task);
  if (exitCode !== 0)
    throw new Error(`Worker exited with code ${String(exitCode)}`);

  const allowed = (config.posts ?? []).map((p) => requireSlackTarget(p.target));
  const posts = parseWorkerPosts(finalText, allowed);

  let posted = 0;
  for (const post of posts) {
    if (deps.dryRun) {
      print(describe(post));
      continue;
    }
    await deliver(deps.slack, post);
    posted += 1;
  }
  print(
    `[worker-slack] ${deps.dryRun ? 'dry-run: would post' : 'posted'} ${String(deps.dryRun ? posts.length : posted)} message(s)`,
  );
  return { task, posts, posted };
}
