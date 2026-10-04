/**
 * @module backfill-window
 *
 * Paced historical Gmail backfill: the per-account cursor, window
 * arithmetic, and per-window thread processing. Settings come from
 * backfill-settings.ts; paging from gmail-search.ts. The entry point is
 * backfill-historical.ts.
 *
 * Each run processes ONE window per account, walking back in time from
 * the newest unprocessed point until the lookback limit, then no-ops:
 *
 * - The cursor (runner state, namespace `email-backfill`, key
 *   `cursor-<email>`) is the ISO instant up to which (exclusive) older
 *   mail has not yet been searched. Absent means "start now".
 * - The window is `[max(cursor - windowDays, now - lookbackDays), cursor)`.
 * - When `cursor <= now - lookbackDays` the account is done.
 * - Search pages are processed one at a time (bounded memory). The
 *   cursor only advances in live mode, after the last page of the window
 *   has been processed. A failed run leaves it in place, so the window
 *   is retried; threads already stored on the failed run count as known.
 *
 * Called by email/google-workspace/backfill-historical.ts.
 */

import type { RunnerClient } from '@karmaniverous/jeeves-runner';

import {
  type EmailStoreClient,
  getThreadState,
  setThreadState,
} from '../email-state.js';
import type { BackfillSettings } from './backfill-settings.js';
import { fetchThreadMetadata } from './email-fetch.js';
import {
  classifyBucket,
  classifyCandidates,
  computeLabelsToApply,
} from './email-triage.js';
import {
  type GogRunner,
  searchThreadPages,
  type ThreadSummary,
} from './gmail-search.js';
import { enqueueLabelActions } from './label-actions.js';

/** Runner state namespace for backfill cursors. */
export const BACKFILL_STATE_NAMESPACE = 'email-backfill';

/** Gmail search page size (`gog gmail search --max`). */
export const BACKFILL_PAGE_SIZE = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Runner state key holding an account's cursor. */
export function backfillCursorKey(account: string): string {
  return `cursor-${account}`;
}

/** A half-open search window `[after, before)`. */
export interface BackfillWindow {
  after: Date;
  before: Date;
}

/**
 * Next window to search, or `null` when the cursor has reached the
 * lookback limit.
 *
 * @throws When the stored cursor is not a parseable instant.
 */
export function nextBackfillWindow(
  cursor: string | null,
  now: Date,
  settings: Pick<BackfillSettings, 'lookbackDays' | 'windowDays'>,
): BackfillWindow | null {
  const limit = now.getTime() - settings.lookbackDays * DAY_MS;
  const before = cursor === null ? now.getTime() : Date.parse(cursor);
  if (Number.isNaN(before)) {
    throw new Error(`Invalid backfill cursor ${JSON.stringify(cursor)}`);
  }
  if (before <= limit) return null;
  const after = Math.max(before - settings.windowDays * DAY_MS, limit);
  return { after: new Date(after), before: new Date(before) };
}

/** Gmail query for a window, using epoch seconds (no timezone ambiguity). */
export function backfillQuery(w: BackfillWindow): string {
  const s = (d: Date) => String(Math.floor(d.getTime() / 1000));
  return `after:${s(w.after)} before:${s(w.before)}`;
}

/** Per-account result of one backfill run. */
export interface BackfillAccountResult {
  account: string;
  window: BackfillWindow | null;
  found: number;
  known: number;
  new: number;
  labelsPlanned: number;
  labelsEnqueued: number;
  cursorAdvancedTo: string | null;
}

/** Dependencies for {@link backfillAccount} (injectable for tests). */
export interface BackfillDeps {
  client: EmailStoreClient;
  gog: GogRunner;
  now: Date;
  live: boolean;
  reportOnly: boolean;
  fetchMetadata?: typeof fetchThreadMetadata;
  pageSize?: number;
}

/** True when the thread is already in the state store. */
function isKnownThread(
  client: Pick<RunnerClient, 'getItem'>,
  account: string,
  threadId: string,
): boolean {
  try {
    return getThreadState(client, account, threadId) !== null;
  } catch {
    // Old-format state item (bare ISO string): already known.
    return true;
  }
}

/** Classify, fetch, label and store one new thread. */
function processNewThread(
  t: ThreadSummary,
  account: string,
  query: string,
  deps: BackfillDeps,
  result: BackfillAccountResult,
): void {
  const { client, live, reportOnly } = deps;
  const { receiptCandidate: rc, junkCandidate: jc } = classifyCandidates(
    t,
    account,
  );
  const bucket = classifyBucket(account, t.to, t.subject, t.snippet, t.from);
  const labelsToApply = computeLabelsToApply({
    receiptCandidate: rc,
    junkCandidate: jc,
    bucket,
  });
  result.new++;
  result.labelsPlanned += labelsToApply.length;
  if (!live) return;

  (deps.fetchMetadata ?? fetchThreadMetadata)({
    account,
    threadId: t.threadId,
    subject: t.subject,
    from: t.from,
    to: t.to,
    receiptCandidate: rc,
    junkCandidate: jc,
    bucket,
    labels: t.labels,
    query,
    client,
    reportOnly,
  });

  const r = enqueueLabelActions(client, {
    account,
    messageId: t.threadId, // no seenMessageIds yet for new threads
    threadId: t.threadId,
    labels: labelsToApply,
    source: 'backfill-historical',
    reason: 'Historical backfill for pre-pipeline thread',
    reportOnly,
  });
  result.labelsEnqueued += r.enqueued;

  setThreadState(client, account, t.threadId, {
    seenAt: deps.now.toISOString(),
    date: t.date ?? undefined,
    messageCount: t.messageCount ?? undefined,
    labels: t.labels,
    receiptCandidate: rc,
    junkCandidate: jc,
    bucket,
    labelApplied: r.applied,
  });
}

/**
 * Process the next window for one account. Dry-run searches and
 * classifies but writes nothing (no state, no queue, no cursor).
 */
export function backfillAccount(
  account: string,
  settings: Pick<BackfillSettings, 'lookbackDays' | 'windowDays'>,
  deps: BackfillDeps,
): BackfillAccountResult {
  const { client } = deps;
  const result: BackfillAccountResult = {
    account,
    window: null,
    found: 0,
    known: 0,
    new: 0,
    labelsPlanned: 0,
    labelsEnqueued: 0,
    cursorAdvancedTo: null,
  };

  const window = nextBackfillWindow(
    client.getState(BACKFILL_STATE_NAMESPACE, backfillCursorKey(account)),
    deps.now,
    settings,
  );
  if (!window) return result;
  result.window = window;

  const query = backfillQuery(window);
  const pages = searchThreadPages(
    deps.gog,
    account,
    query,
    deps.pageSize ?? BACKFILL_PAGE_SIZE,
  );
  for (const threads of pages) {
    result.found += threads.length;
    for (const t of threads) {
      if (isKnownThread(client, account, t.threadId)) {
        result.known++;
        continue;
      }
      processNewThread(t, account, query, deps, result);
    }
  }

  if (deps.live) {
    const cursor = window.after.toISOString();
    client.setState(
      BACKFILL_STATE_NAMESPACE,
      backfillCursorKey(account),
      cursor,
    );
    result.cursorAdvancedTo = cursor;
  }
  return result;
}
