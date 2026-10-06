/**
 * @module meetings/lib/pending-actions
 *
 * Defers the Gmail actions of meetings packaged while
 * `emailConfig.reportOnly` is on, and catches them up once it is off.
 *
 * The record is a *pending* marker, written only when a new meeting's
 * actions are suppressed by `reportOnly`. It starts empty, so meetings
 * packaged before this module existed are never caught up: there is no
 * migration and no risk of mass-archiving old mail.
 *
 * Catch-up uses the message's *current* labels from the thread cache, not
 * the labels it had when it was packaged: a message a human has since
 * labelled `watch`, or already moved out of the inbox, is not archived. A
 * message no longer in the cache gets the `meeting` label only. Catch-up
 * is capped per run so turning `reportOnly` off after a long window drains
 * gradually, and every enqueued action goes through the single
 * `enqueueEmailUpdates` gate.
 */

import type { RunnerClient } from '@karmaniverous/jeeves-runner';

import {
  enqueueMeetingEmailActions,
  type MeetingEmailActionOptions,
  type MeetingMessageRef,
} from './email-actions.js';

/** Runner-state namespace and collection holding pending meeting actions. */
export const PENDING_NAMESPACE = 'meetings';
export const PENDING_COLLECTION = 'pendingEmailActions';
/**
 * Collection that unreadable pending records are moved to, verbatim. They
 * are reported and never retried; inspect and re-queue or delete by hand.
 */
export const INVALID_COLLECTION = 'pendingEmailActionsInvalid';

/** Most pending meetings caught up in one run. */
export const CATCH_UP_PER_RUN = 20;

/** The message whose actions are pending. */
export interface PendingMessage {
  account: string;
  threadId: string;
  messageId: string;
}

/** Runner client methods this module uses. */
export type PendingClient = Pick<
  RunnerClient,
  'getItem' | 'setItem' | 'deleteItem' | 'listItemKeys' | 'enqueue'
>;

/** Key of a message in the current-labels map. */
export function messageKey(m: PendingMessage): string {
  return `${m.account}\u0000${m.threadId}\u0000${m.messageId}`;
}

/**
 * Handle a newly packaged meeting's Gmail actions: enqueue them, or, under
 * `reportOnly`, record them as pending for a later catch-up.
 *
 * @returns How many actions were queued, and whether they were deferred.
 */
export function handleNewMeetingEmailActions(
  client: Pick<RunnerClient, 'setItem' | 'enqueue'>,
  sourceKey: string,
  ref: MeetingMessageRef,
  options: MeetingEmailActionOptions & { reportOnly: boolean },
): { queued: number; deferred: boolean } {
  const { reportOnly, ...actionOptions } = options;
  if (reportOnly) {
    deferMeetingEmailActions(client, sourceKey, ref);
    return { queued: 0, deferred: true };
  }
  return {
    queued: enqueueMeetingEmailActions(client, ref, reportOnly, actionOptions),
    deferred: false,
  };
}

/** Record that a new meeting's Gmail actions were suppressed by reportOnly. */
export function deferMeetingEmailActions(
  client: Pick<RunnerClient, 'setItem'>,
  sourceKey: string,
  message: PendingMessage,
): void {
  const { account, threadId, messageId } = message;
  client.setItem(
    PENDING_NAMESPACE,
    PENDING_COLLECTION,
    sourceKey,
    JSON.stringify({ account, threadId, messageId }),
  );
}

function parsePending(raw: string | null): PendingMessage | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (
      v !== null &&
      typeof v === 'object' &&
      'account' in v &&
      'threadId' in v &&
      'messageId' in v &&
      typeof v.account === 'string' &&
      typeof v.threadId === 'string' &&
      typeof v.messageId === 'string'
    )
      return {
        account: v.account,
        threadId: v.threadId,
        messageId: v.messageId,
      };
  } catch {
    // fall through: the caller quarantines unreadable records
  }
  return null;
}

/** Outcome of one catch-up pass. */
export interface CatchUpResult {
  /** Pending meetings whose actions were enqueued. */
  caughtUp: number;
  /** Actions enqueued. */
  queued: number;
  /** Pending meetings left for later runs. */
  remaining: number;
  /** Keys of unreadable records moved to {@link INVALID_COLLECTION}. */
  invalid: string[];
}

/**
 * Enqueue the actions of up to `limit` pending meetings, then clear their
 * markers. Call only when `reportOnly` is off.
 *
 * @param currentLabels - current Gmail labels by {@link messageKey}, from
 *   the thread cache scanned this run.
 */
export function catchUpMeetingEmailActions(
  client: PendingClient,
  currentLabels: ReadonlyMap<string, string[]>,
  options: MeetingEmailActionOptions & { limit?: number } = {},
): CatchUpResult {
  const { limit = CATCH_UP_PER_RUN, ...actionOptions } = options;
  const keys = client.listItemKeys(PENDING_NAMESPACE, PENDING_COLLECTION);
  let caughtUp = 0;
  let queued = 0;
  const invalid: string[] = [];
  for (const key of keys) {
    if (caughtUp >= limit) break;
    const raw = client.getItem(PENDING_NAMESPACE, PENDING_COLLECTION, key);
    const pending = parsePending(raw);
    if (pending) {
      const labels = currentLabels.get(messageKey(pending)) ?? [];
      queued += enqueueMeetingEmailActions(
        client,
        { ...pending, labels },
        false,
        actionOptions,
      );
      caughtUp++;
    } else if (raw !== null) {
      // Unreadable record: keep it, verbatim, where it won't be retried, so
      // a corrupt record never silently discards a promised action.
      client.setItem(PENDING_NAMESPACE, INVALID_COLLECTION, key, raw);
      invalid.push(key);
    }
    client.deleteItem(PENDING_NAMESPACE, PENDING_COLLECTION, key);
  }
  return {
    caughtUp,
    queued,
    invalid,
    remaining: client.listItemKeys(PENDING_NAMESPACE, PENDING_COLLECTION)
      .length,
  };
}
