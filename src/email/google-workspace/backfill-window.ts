/**
 * @module backfill-window
 *
 * Paced historical Gmail backfill: settings resolution, the per-account
 * cursor, window arithmetic, paginated search, and per-window thread
 * processing. The entry point is backfill-historical.ts.
 *
 * Each run processes ONE window per account, walking back in time from
 * the newest unprocessed point until the lookback limit, then no-ops:
 *
 * - The cursor (runner state, namespace `email-backfill`, key
 *   `cursor-<email>`) is the ISO instant up to which (exclusive) older
 *   mail has not yet been searched. Absent means "start now".
 * - The window is `[max(cursor - windowDays, now - lookbackDays), cursor)`.
 * - When `cursor <= now - lookbackDays` the account is done.
 * - The cursor only advances in live mode, after the whole window has
 *   been searched (all pages) and processed. A failed run leaves it in
 *   place, so the window is retried.
 *
 * There are NO default accounts, lookback, or window: they come from
 * `emailConfig.backfill` in pipeline-config.json or CLI args; missing
 * values are an error.
 *
 * Called by email/google-workspace/backfill-historical.ts.
 */

import type { RunnerClient } from '@karmaniverous/jeeves-runner';
import { z } from 'zod';

import type { BackfillConfig } from '../../lib/pipeline-config.js';
import { getThreadState, setThreadState } from '../email-state.js';
import { fetchThreadMetadata } from './email-fetch.js';
import {
  classifyBucket,
  computeLabelsToApply,
  isJunkCandidate,
  isReceiptCandidate,
} from './email-triage.js';
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

/** Resolved backfill settings. */
export interface BackfillSettings {
  accounts: string[];
  lookbackDays: number;
  windowDays: number;
}

const positiveInt = z.coerce.number().int().positive();

function argValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

function parseDays(raw: string, flag: string): number {
  const parsed = positiveInt.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${flag} must be a positive integer, got "${raw}"`);
  }
  return parsed.data;
}

/**
 * Resolve settings from CLI args (`--accounts a,b`, `--lookback-days N`,
 * `--window-days N`), falling back per field to `emailConfig.backfill`.
 *
 * @throws When any field is missing from both, or invalid.
 */
export function resolveBackfillSettings(
  config: BackfillConfig | undefined,
  argv: string[],
): BackfillSettings {
  const accountsArg = argValue(argv, '--accounts');
  const lookbackArg = argValue(argv, '--lookback-days');
  const windowArg = argValue(argv, '--window-days');

  const accounts =
    accountsArg !== undefined
      ? accountsArg
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean)
      : config?.accounts;
  const lookbackDays =
    lookbackArg !== undefined
      ? parseDays(lookbackArg, '--lookback-days')
      : config?.lookbackDays;
  const windowDays =
    windowArg !== undefined
      ? parseDays(windowArg, '--window-days')
      : config?.windowDays;

  const missing: string[] = [];
  if (!accounts || accounts.length === 0) missing.push('accounts (--accounts)');
  if (lookbackDays === undefined)
    missing.push('lookbackDays (--lookback-days)');
  if (windowDays === undefined) missing.push('windowDays (--window-days)');
  if (missing.length > 0 || !accounts || !lookbackDays || !windowDays) {
    throw new Error(
      `email/backfill-historical: missing ${missing.join(', ')}. ` +
        'Set emailConfig.backfill in pipeline-config.json or pass the CLI args; there are no defaults.',
    );
  }
  return { accounts, lookbackDays, windowDays };
}

/** A half-open search window `[after, before)`. */
export interface BackfillWindow {
  after: Date;
  before: Date;
}

/**
 * Next window to search, or `null` when the cursor has reached the
 * lookback limit.
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

/** Read an account's cursor from the runner state store. */
export function loadBackfillCursor(
  client: Pick<RunnerClient, 'getState'>,
  account: string,
): string | null {
  return client.getState(BACKFILL_STATE_NAMESPACE, backfillCursorKey(account));
}

/** Persist an account's cursor to the runner state store. */
export function saveBackfillCursor(
  client: Pick<RunnerClient, 'setState'>,
  account: string,
  cursor: string,
): void {
  client.setState(BACKFILL_STATE_NAMESPACE, backfillCursorKey(account), cursor);
}

/** Runs a gog command and returns stdout. */
export type GogRunner = (args: string[]) => string;

/**
 * Search Gmail threads for `query`, following `nextPageToken` until it
 * is empty. gog: `gog gmail search <query> --max N --page <token> --json`
 * returns `{ threads: [...], nextPageToken: string }`.
 */
export function searchAllThreads(
  gog: GogRunner,
  account: string,
  query: string,
  pageSize = BACKFILL_PAGE_SIZE,
): Array<Record<string, unknown>> {
  const all: Array<Record<string, unknown>> = [];
  const seenTokens = new Set<string>();
  let page: string | undefined;
  for (;;) {
    const args = [
      'gmail',
      'search',
      query,
      '--max',
      String(pageSize),
      '--json',
      '--account',
      account,
    ];
    if (page) args.push('--page', page);
    const out = gog(args);
    const payload = out
      ? (JSON.parse(out) as {
          threads?: Array<Record<string, unknown>> | null;
          nextPageToken?: string | null;
        })
      : {};
    all.push(...(payload.threads ?? []));
    const next = payload.nextPageToken ?? '';
    if (!next) break;
    if (seenTokens.has(next)) {
      throw new Error(`gog returned a repeated page token for ${account}`);
    }
    seenTokens.add(next);
    page = next;
  }
  return all;
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
  client: RunnerClient;
  gog: GogRunner;
  now: Date;
  live: boolean;
  reportOnly: boolean;
  fetchMetadata?: typeof fetchThreadMetadata;
}

/**
 * Process the next window for one account. Dry-run searches and
 * classifies but writes nothing (no state, no queue, no cursor).
 */
export function backfillAccount(
  account: string,
  settings: BackfillSettings,
  deps: BackfillDeps,
): BackfillAccountResult {
  const { client, live, reportOnly } = deps;
  const fetchMeta = deps.fetchMetadata ?? fetchThreadMetadata;
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
    loadBackfillCursor(client, account),
    deps.now,
    settings,
  );
  if (!window) return result;
  result.window = window;

  const query = backfillQuery(window);
  const threads = searchAllThreads(deps.gog, account, query);
  result.found = threads.length;

  for (const t of threads) {
    const tid = (t.threadId as string) || (t.id as string) || '';
    if (!tid) continue;
    const subj = (t.subject as string) || '';
    const snip = (t.snippet as string) || '';
    const from = (t.from as string) || '';
    const to = (t.to as string) || '';
    const date = (t.date as string) || null;
    const mc = Number.isFinite(t.messageCount)
      ? (t.messageCount as number)
      : null;
    const labels = Array.isArray(t.labels) ? (t.labels as string[]) : [];

    let prev;
    try {
      prev = getThreadState(client, account, tid);
    } catch {
      // Old-format state item (bare ISO string): already known.
      result.known++;
      continue;
    }
    if (prev) {
      result.known++;
      continue;
    }

    const rc = isReceiptCandidate(subj, snip, from, account);
    const jc = !rc && isJunkCandidate(subj, snip, from);
    const bucket = classifyBucket(account, to, subj, snip, from);
    const labelsToApply = computeLabelsToApply({
      receiptCandidate: rc,
      junkCandidate: jc,
      bucket,
    });
    result.new++;
    result.labelsPlanned += labelsToApply.length;

    if (!live) continue;

    fetchMeta({
      account,
      threadId: tid,
      subject: subj,
      from,
      to,
      receiptCandidate: rc,
      junkCandidate: jc,
      bucket,
      labels,
      query,
      client,
    });

    const r = enqueueLabelActions(client, {
      account,
      messageId: tid, // no seenMessageIds yet for new threads
      threadId: tid,
      labels: labelsToApply,
      source: 'backfill-historical',
      reason: 'Historical backfill for pre-pipeline thread',
      reportOnly,
    });
    result.labelsEnqueued += r.enqueued;

    setThreadState(client, account, tid, {
      seenAt: deps.now.toISOString(),
      date: date ?? undefined,
      messageCount: mc ?? undefined,
      labels,
      receiptCandidate: rc,
      junkCandidate: jc,
      bucket,
      labelApplied: r.applied,
    });
  }

  if (live) {
    const cursor = window.after.toISOString();
    saveBackfillCursor(client, account, cursor);
    result.cursorAdvancedTo = cursor;
  }
  return result;
}
