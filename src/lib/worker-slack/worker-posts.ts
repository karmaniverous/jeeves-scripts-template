/**
 * @module worker-slack/worker-posts
 *
 * The worker ↔ job Slack contract. Workers have no Slack tool on OpenClaw
 * 2026.9, so:
 * - the job reads Slack before dispatch and appends it to the TASK
 *   ({@link formatSlackContext});
 * - the TASK tells the worker never to call Slack and to return intended
 *   posts in its final reply ({@link slackOutputInstructions});
 * - the job parses those posts ({@link parseWorkerPosts}) and posts them.
 *
 * Output contract: the worker's final reply contains exactly one fenced
 * block with info string `slack-posts` holding a JSON array (`[]` when
 * there is nothing to post):
 *
 *     ```slack-posts
 *     [{ "channel": "C0B2Z734KSP", "text": "…", "pin": true },
 *      { "channel": "C0B2Z734KSP", "thread_ts": "1790…", "text": "…" },
 *      { "channel": "C0B2Z734KSP", "edit_ts": "1789…", "text": "…" }]
 *     ```
 */

import { z } from 'zod';

import type { SlackMessage } from './slack-io.js';
import { normalizeSlackTarget } from './slack-target.js';

/** One post the worker wants the job to make. */
export interface WorkerPost {
  /** Normalized target (`channel:C…` / `user:U…`). */
  channel: string;
  /** Reply in this thread. */
  thread_ts?: string;
  /** Message text (Slack mrkdwn). */
  text: string;
  /** Pin the posted message. */
  pin?: boolean;
  /** Edit this existing message (ts) instead of posting a new one. */
  edit_ts?: string;
}

const postSchema = z
  .object({
    channel: z.string().min(1),
    thread_ts: z
      .string()
      .regex(/^\d+\.\d+$/)
      .optional(),
    text: z.string().trim().min(1).max(39_000),
    pin: z.boolean().optional(),
    edit_ts: z
      .string()
      .regex(/^\d+\.\d+$/)
      .optional(),
  })
  .strict()
  .refine((p) => !(p.edit_ts && (p.thread_ts || p.pin)), {
    message: 'edit_ts cannot be combined with thread_ts or pin',
  });

const FENCE =
  /(^|\n)(`{3,}|~{3,})[ \t]*slack-posts[ \t]*\r?\n([\s\S]*?)\r?\n\2[ \t]*(?=\r?\n|$)/g;

/** A labelled Slack read made before dispatch. */
export interface SlackContextBlock {
  /** Human label, e.g. `#ops-ceo (C0B2Z734KSP)`. */
  label: string;
  /** Messages, oldest first. */
  messages: SlackMessage[];
}

/**
 * Parse and validate the worker's posts.
 *
 * @param finalText - The worker's final reply.
 * @param allowedTargets - Normalized targets the job may post to.
 * @returns The validated posts (possibly empty).
 * @throws Error when the block is missing, duplicated, malformed, or
 *   targets a channel outside the allowlist. Nothing should be posted
 *   when this throws.
 */
export function parseWorkerPosts(
  finalText: string | null,
  allowedTargets: readonly string[],
): WorkerPost[] {
  const blocks = [...(finalText ?? '').matchAll(FENCE)];
  if (blocks.length === 0)
    throw new Error('Worker reply has no `slack-posts` block');
  if (blocks.length > 1)
    throw new Error('Worker reply has more than one `slack-posts` block');

  let raw: unknown;
  try {
    raw = JSON.parse(blocks[0][3]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`\`slack-posts\` block is not valid JSON: ${msg}`, {
      cause: err,
    });
  }
  const parsed = z
    .array(postSchema)
    .safeParse(Array.isArray(raw) ? raw : [raw]);
  if (!parsed.success)
    throw new Error(`Invalid \`slack-posts\` block: ${parsed.error.message}`);

  const allowed = new Set(allowedTargets);
  return parsed.data.map((p) => {
    const channel = normalizeSlackTarget(p.channel);
    if (!channel || !allowed.has(channel))
      throw new Error(
        `Worker tried to post to "${p.channel}", which is not an allowed target for this job`,
      );
    return { ...p, channel };
  });
}

/**
 * TASK text telling the worker how Slack works for this job.
 *
 * @param targets - Allowed targets with a short purpose each.
 * @returns Instructions to append to the TASK.
 */
export function slackOutputInstructions(
  targets: readonly { target: string; purpose: string }[],
): string {
  const list = targets.length
    ? targets.map((t) => `- ${t.target}: ${t.purpose}`).join('\n')
    : '- (none: this job does not post to Slack; return an empty array)';
  return `## Slack (handled by the job, not by you)

You have NO Slack access: do not call the message tool or any Slack tool, and do not try to read Slack. If the job read Slack messages for you, they are included above under "Slack context". The job script posts to Slack for you.

To post, end your final reply with exactly one fenced block whose info string is \`slack-posts\`, containing a JSON array of posts (use [] if there is nothing to post):

\`\`\`slack-posts
[{"channel": "<target id>", "text": "<Slack mrkdwn>", "thread_ts": "<optional thread ts>", "pin": false}]
\`\`\`

Fields: "channel" and "text" are required. "thread_ts" replies in a thread. "pin": true pins the new message. "edit_ts": "<ts>" replaces the text of an existing message instead of posting (no thread_ts/pin with edit_ts).

Allowed targets (any other target fails the whole job):
${list}`;
}

function stamp(ts: string): string {
  const ms = Number(ts) * 1000;
  return Number.isFinite(ms)
    ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    : ts;
}

/**
 * Format pre-dispatch Slack reads for the TASK.
 *
 * @param blocks - Labelled reads.
 * @returns A "Slack context" section, or '' when there are no reads.
 */
export function formatSlackContext(
  blocks: readonly SlackContextBlock[],
): string {
  if (blocks.length === 0) return '';
  const sections = blocks.map((b) => {
    const lines = b.messages.length
      ? b.messages.map(
          (m) =>
            `[${stamp(m.ts)}] ts=${m.ts}${m.threadTs ? ` thread_ts=${m.threadTs}` : ''} ${m.user ?? 'unknown'}: ${m.text.replace(/\r?\n/g, '\n    ')}`,
        )
      : ['(no messages)'];
    return `### ${b.label} (oldest first)\n${lines.join('\n')}`;
  });
  return `## Slack context (read by the job before dispatch)\n\n${sections.join('\n\n')}`;
}
