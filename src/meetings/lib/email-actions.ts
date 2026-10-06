/**
 * @module meetings/lib/email-actions
 *
 * Gmail actions for a thread that meetings/extract.ts has just turned
 * into a new meeting package: add the `meeting` label and, if the
 * message is in the inbox and not `watch`ed, archive it. A `watch` label
 * means a human moved the message back to the inbox, so it stays there.
 * Archiving can be switched off with `emailConfig.meetings.archive: false`
 * (labels only); it is on when the block is absent.
 *
 * The actions are enqueued through `enqueueEmailUpdates` (label-actions),
 * the single `emailConfig.reportOnly` gate for `email-updates` writes.
 */

import type { RunnerClient } from '@karmaniverous/jeeves-runner';

import {
  type EmailUpdateAction,
  enqueueEmailUpdates,
} from '../../email/google-workspace/label-actions.js';

/** Source recorded on every action this module builds. */
export const MEETING_ACTION_SOURCE = 'extract-email-meetings';

/** The message a new meeting package was built from. */
export interface MeetingMessageRef {
  account: string;
  threadId: string;
  messageId: string;
  /** Gmail labels on the message (from the thread cache). */
  labels: string[];
}

/** Options for {@link meetingEmailActions}. */
export interface MeetingEmailActionOptions {
  /** Archive inbox, un-`watch`ed messages. Default `true`. */
  archive?: boolean;
}

/**
 * Actions for a new meeting: the `meeting` label, plus an archive when
 * `archive` is on (default) and the message is in `INBOX` with no `watch`
 * label.
 */
export function meetingEmailActions(
  ref: MeetingMessageRef,
  { archive = true }: MeetingEmailActionOptions = {},
): EmailUpdateAction[] {
  const base = {
    account: ref.account,
    threadId: ref.threadId,
    messageId: ref.messageId,
    source: MEETING_ACTION_SOURCE,
  };
  const actions: EmailUpdateAction[] = [
    {
      ...base,
      action: 'addLabel',
      label: 'meeting',
      reason: 'Meeting package created from this message',
    },
  ];
  if (archive && ref.labels.includes('INBOX') && !ref.labels.includes('watch'))
    actions.push({
      ...base,
      action: 'archive',
      reason: 'Meeting email archived after packaging',
    });
  return actions;
}

/**
 * Enqueue {@link meetingEmailActions} for `ref`, unless `reportOnly`.
 *
 * @returns The number of actions enqueued (0 in reportOnly).
 */
export function enqueueMeetingEmailActions(
  client: Pick<RunnerClient, 'enqueue'>,
  ref: MeetingMessageRef,
  reportOnly: boolean,
  options: MeetingEmailActionOptions = {},
): number {
  const actions = meetingEmailActions(ref, options);
  return enqueueEmailUpdates(client, actions, reportOnly) ? actions.length : 0;
}
