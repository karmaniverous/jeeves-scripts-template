/**
 * @module label-actions
 *
 * Every write to the `email-updates` queue (Gmail label mutations) goes
 * through this module, so `emailConfig.reportOnly` is enforced in one
 * place.
 *
 * When `reportOnly` is true the pipeline still ingests and archives
 * mail, but nothing is written back to Gmail:
 *
 * - producers enqueue no `email-updates` actions
 *   ({@link enqueueEmailUpdates}): classification labels from poll and
 *   backfill-historical ({@link enqueueLabelActions}) and human-curation
 *   signals detected by email-fetch ({@link curationSignalActions});
 * - the consumer (drain-updates) applies none, as defence in depth
 *   against items enqueued before `reportOnly` was turned on
 *   ({@link planDrain}). Those items stay pending, untouched.
 *
 * Called by email/poll.ts, email/google-workspace/backfill-window.ts,
 * email/google-workspace/email-fetch.ts and
 * email/google-workspace/drain-updates.ts.
 */

import { nowIso } from '@karmaniverous/jeeves';
import type { RunnerClient } from '@karmaniverous/jeeves-runner';

import {
  type GogCredentials,
  requireGogCredentials,
} from '../../lib/gog-credentials.js';

/** Queue consumed by drain-updates. */
export const EMAIL_UPDATES_QUEUE = 'email-updates';

/** A Gmail label mutation for drain-updates (without its timestamp). */
export interface EmailUpdateAction {
  account: string;
  threadId: string;
  messageId: string;
  action: 'addLabel' | 'removeLabel';
  label: string;
  source: string;
  reason: string;
}

/**
 * Enqueue `actions` on {@link EMAIL_UPDATES_QUEUE}, stamped with one
 * `createdAt`, unless `reportOnly`.
 *
 * @returns The stamp used, or `null` when nothing was enqueued.
 */
export function enqueueEmailUpdates(
  client: Pick<RunnerClient, 'enqueue'>,
  actions: EmailUpdateAction[],
  reportOnly: boolean,
): string | null {
  if (reportOnly || actions.length === 0) return null;
  const createdAt = nowIso();
  for (const a of actions) {
    client.enqueue(EMAIL_UPDATES_QUEUE, { ...a, createdAt });
  }
  return createdAt;
}

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
  const { labels, reportOnly, ...base } = opts;
  const stamp = enqueueEmailUpdates(
    client,
    labels.map((label) => ({ ...base, action: 'addLabel', label })),
    reportOnly,
  );
  const applied: Record<string, string> = {};
  if (stamp) for (const label of labels) applied[label] = stamp;
  return {
    applied,
    planned: labels.length,
    enqueued: stamp ? labels.length : 0,
  };
}

/** Inputs for {@link curationSignalActions}. */
export interface CurationSignalInput {
  account: string;
  threadId: string;
  messageId: string;
  /** Labels on the message in the thread cache (previous fetch). */
  cachedLabels: string[];
  /** Labels on the message now. */
  currentLabels: string[];
  /** Whether the pipeline had already seen this message. */
  seenBefore: boolean;
}

/**
 * Label actions implied by a human curating a message since the last
 * fetch:
 *
 * - a seen message moved from the archive back to the inbox gets the
 *   `watch` label;
 * - a `watch`ed message that has been archived loses `watch`.
 */
export function curationSignalActions(
  input: CurationSignalInput,
): EmailUpdateAction[] {
  const { account, threadId, messageId } = input;
  const was = new Set(input.cachedLabels);
  const now = new Set(input.currentLabels);
  const actions: EmailUpdateAction[] = [];
  if (!was.has('INBOX') && now.has('INBOX') && input.seenBefore) {
    actions.push({
      account,
      messageId,
      threadId,
      action: 'addLabel',
      label: 'watch',
      source: 'poll-curation-signal',
      reason: 'Human moved archived email back to inbox',
    });
  }
  if (now.has('watch') && !now.has('INBOX')) {
    actions.push({
      account,
      messageId,
      threadId,
      action: 'removeLabel',
      label: 'watch',
      source: 'poll-curation-signal',
      reason: 'Watched email archived',
    });
  }
  return actions;
}

/** What drain-updates should do this run. */
export type DrainPlan = 'report-only' | 'skip' | 'run';

/**
 * Decide whether drain-updates may touch Gmail.
 *
 * - no Gmail accounts configured: `'skip'`.
 * - Gmail accounts but no gog credentials: throws (visible failure),
 *   whether or not `reportOnly` is set.
 * - `reportOnly`: `'report-only'` (dequeue nothing, apply nothing).
 * - otherwise `'run'`.
 */
export function planDrain(
  reportOnly: boolean,
  gmailAccountCount: number,
  creds?: GogCredentials,
): DrainPlan {
  if (!requireGogCredentials('email/drain-updates', gmailAccountCount, creds))
    return 'skip';
  return reportOnly ? 'report-only' : 'run';
}
