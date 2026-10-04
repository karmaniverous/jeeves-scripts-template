/**
 * @module label-actions
 *
 * Gmail mutation gating for `emailConfig.reportOnly`.
 *
 * When `reportOnly` is true the pipeline still ingests and archives
 * mail, but nothing is written back to Gmail:
 *
 * - producers (poll, backfill-historical) enqueue no `email-updates`
 *   actions ({@link enqueueLabelActions});
 * - the consumer (drain-updates) applies none, as defence in depth
 *   against items enqueued before `reportOnly` was turned on
 *   ({@link planDrain}). Those items stay pending, untouched.
 *
 * Called by email/poll.ts, email/google-workspace/backfill-historical.ts
 * and email/google-workspace/drain-updates.ts.
 */

import { nowIso } from '@karmaniverous/jeeves';
import type { RunnerClient } from '@karmaniverous/jeeves-runner';

import {
  type GogCredentials,
  requireGogCredentials,
} from '../../lib/gog-credentials.js';

/** Queue consumed by drain-updates. */
export const EMAIL_UPDATES_QUEUE = 'email-updates';

/** Inputs for {@link enqueueLabelActions}. */
export interface EnqueueLabelActionsOptions {
  account: string;
  threadId: string;
  messageId: string;
  labels: string[];
  source: string;
  reason: string;
  reportOnly: boolean;
}

/** Result of {@link enqueueLabelActions}. */
export interface EnqueueLabelActionsResult {
  /** Label → timestamp for every label actually enqueued. */
  applied: Record<string, string>;
  /** Labels that would have been enqueued (all of them in reportOnly). */
  planned: number;
  /** Labels actually enqueued (0 in reportOnly). */
  enqueued: number;
}

/**
 * Enqueue one `addLabel` action per label, unless `reportOnly`.
 *
 * In reportOnly mode nothing is enqueued and `applied` is empty, so the
 * thread state does not record labels that were never applied.
 */
export function enqueueLabelActions(
  client: Pick<RunnerClient, 'enqueue'>,
  opts: EnqueueLabelActionsOptions,
): EnqueueLabelActionsResult {
  const applied: Record<string, string> = {};
  if (opts.reportOnly) {
    return { applied, planned: opts.labels.length, enqueued: 0 };
  }
  const stamp = nowIso();
  for (const label of opts.labels) {
    client.enqueue(EMAIL_UPDATES_QUEUE, {
      account: opts.account,
      messageId: opts.messageId,
      threadId: opts.threadId,
      action: 'addLabel',
      label,
      source: opts.source,
      reason: opts.reason,
      createdAt: stamp,
    });
    applied[label] = stamp;
  }
  return {
    applied,
    planned: opts.labels.length,
    enqueued: opts.labels.length,
  };
}

/** What drain-updates should do this run. */
export type DrainPlan = 'report-only' | 'skip' | 'run';

/**
 * Decide whether drain-updates may touch Gmail.
 *
 * - `reportOnly`: `'report-only'` (dequeue nothing, apply nothing).
 * - no Gmail accounts configured: `'skip'`.
 * - Gmail accounts but no gog credentials: throws (visible failure).
 * - otherwise `'run'`.
 */
export function planDrain(
  reportOnly: boolean,
  gmailAccountCount: number,
  creds?: GogCredentials,
): DrainPlan {
  if (reportOnly) return 'report-only';
  return requireGogCredentials('email/drain-updates', gmailAccountCount, creds)
    ? 'run'
    : 'skip';
}
