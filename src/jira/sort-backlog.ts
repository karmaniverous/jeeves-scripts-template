#!/usr/bin/env tsx
/**
 * @module sort-backlog
 *
 * Stable-sort the Jira backlog by priority group.
 *
 * Issues retain their existing relative order within each priority group,
 * but the groups are collected: no-priority on top, then Highest → Lowest.
 *
 * Usage:
 *   tsx src/jira/sort-backlog.ts          # dry-run (default)
 *   tsx src/jira/sort-backlog.ts --live   # actually re-rank
 *
 * Designed to run ad-hoc and as a daily runner job.
 */

import {
  JIRA_API_TOKEN_PATH,
  JIRA_EMAIL,
  JIRA_SITE_URL,
} from '../lib/constants.js';
import { makeAuthHeader, readApiToken } from './lib/jira-client.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BOARD_ID = Number(process.env.JIRA_BOARD_ID ?? '');
if (!BOARD_ID || isNaN(BOARD_ID)) {
  console.error(
    'Error: Set JIRA_BOARD_ID environment variable to your Jira board ID.',
  );
  process.exit(1);
}
const RANK_BATCH_SIZE = 50; // Jira Agile API max per call

/**
 * Priority sort order. Lower index = higher on board.
 * Issues with no priority (null) sort to top per requirements.
 */
const PRIORITY_ORDER: (string | null)[] = [
  null, // No priority → top
  'Highest',
  'High',
  'Medium',
  'Low',
  'Lowest',
];

// ---------------------------------------------------------------------------
// Agile API helpers (board/rank endpoints live under /rest/agile/1.0/)
// ---------------------------------------------------------------------------

async function agileGet<T>(
  authHeader: string,
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const url = new URL(`${JIRA_SITE_URL}/rest/agile/1.0/${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: authHeader, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Agile GET ${String(res.status)} ${path}: ${body}`);
  }
  return res.json() as Promise<T>;
}

async function agilePut(
  authHeader: string,
  path: string,
  body: unknown,
): Promise<void> {
  const url = new URL(`${JIRA_SITE_URL}/rest/agile/1.0/${path}`);
  const res = await fetch(url.toString(), {
    method: 'PUT',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Agile PUT ${String(res.status)} ${path}: ${body}`);
  }
}

// ---------------------------------------------------------------------------
// Backlog fetch (paginated)
// ---------------------------------------------------------------------------

interface AgileIssue {
  id: string;
  key: string;
  fields: {
    priority?: { name: string } | null;
    summary?: string;
    issuetype?: { name: string } | null;
    [k: string]: unknown;
  };
}

interface BoardBacklogResponse {
  maxResults: number;
  startAt: number;
  total: number;
  issues: AgileIssue[];
}

async function fetchBacklog(authHeader: string): Promise<AgileIssue[]> {
  const all: AgileIssue[] = [];
  let startAt = 0;
  const pageSize = 50;

  for (;;) {
    const page = await agileGet<BoardBacklogResponse>(
      authHeader,
      `board/${String(BOARD_ID)}/backlog`,
      {
        startAt: String(startAt),
        maxResults: String(pageSize),
        fields: 'priority,summary,issuetype',
      },
    );
    all.push(...page.issues);
    if (all.length >= page.total || page.issues.length === 0) break;
    startAt += page.issues.length;
  }

  return all;
}

// ---------------------------------------------------------------------------
// Sort logic
// ---------------------------------------------------------------------------

function priorityRank(priorityName: string | null): number {
  const idx = PRIORITY_ORDER.indexOf(priorityName);
  // Unknown priorities sort just before Lowest (between Low and Lowest)
  return idx >= 0 ? idx : PRIORITY_ORDER.length - 1.5;
}

function getPriorityName(issue: AgileIssue): string | null {
  return issue.fields.priority?.name ?? null;
}

/**
 * Stable-sort issues by priority group.
 * Returns the new order (same issues, possibly reordered).
 */
function stableSortByPriority(issues: AgileIssue[]): AgileIssue[] {
  // Assign each issue its original index for stable sort
  const indexed = issues.map((issue, i) => ({ issue, origIdx: i }));
  indexed.sort((a, b) => {
    const pa = priorityRank(getPriorityName(a.issue));
    const pb = priorityRank(getPriorityName(b.issue));
    if (pa !== pb) return pa - pb;
    return a.origIdx - b.origIdx; // stable: preserve original order within group
  });
  return indexed.map((x) => x.issue);
}

// ---------------------------------------------------------------------------
// Re-rank
// ---------------------------------------------------------------------------

async function rerank(
  authHeader: string,
  sortedKeys: string[],
  live: boolean,
): Promise<number> {
  // Split the sorted key list into chunks of RANK_BATCH_SIZE.
  const batches: string[][] = [];
  for (let i = 0; i < sortedKeys.length; i += RANK_BATCH_SIZE) {
    batches.push(sortedKeys.slice(i, i + RANK_BATCH_SIZE));
  }

  if (batches.length === 0) return 0;

  let apiCalls = 0;

  // Process in reverse order. Each batch is ranked before the first issue
  // of the batch that was just placed below it. The last (lowest-priority)
  // batch has no anchor below it, so we rank it after its own first issue
  // to establish its internal order.
  for (let b = batches.length - 1; b >= 0; b--) {
    const batch = batches[b];

    if (b < batches.length - 1) {
      // Rank this batch before the first issue of the batch below it.
      const anchor = batches[b + 1][0];
      if (live) {
        await agilePut(authHeader, 'issue/rank', {
          issues: batch,
          rankBeforeIssue: anchor,
        });
      } else {
        console.log(
          `[dry-run] Would rank ${String(batch.length)} issues (batch ${String(b)}) before ${anchor}`,
        );
      }
      apiCalls++;
    } else {
      // Last batch (bottom of backlog): rank all issues after the first
      // issue in this batch to establish internal order.
      if (batch.length <= 1) continue;
      const [first, ...rest] = batch;
      if (live) {
        await agilePut(authHeader, 'issue/rank', {
          issues: rest,
          rankAfterIssue: first,
        });
      } else {
        console.log(
          `[dry-run] Would rank ${String(rest.length)} issues (batch ${String(b)} tail) after ${first}`,
        );
      }
      apiCalls++;
    }
  }

  return apiCalls;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const live = process.argv.includes('--live');
  const mode = live ? 'LIVE' : 'DRY-RUN';

  console.log(`\n=== Jira Backlog Priority Sort (${mode}) ===\n`);

  // Guard: skip cleanly if credentials are not configured
  if (!JIRA_SITE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN_PATH) {
    console.log('[skip] Jira API credentials not configured');
    return;
  }

  // Auth
  const apiToken = readApiToken(JIRA_API_TOKEN_PATH);
  const authHeader = makeAuthHeader(JIRA_EMAIL, apiToken);

  // 1. Fetch backlog
  console.log(`Fetching backlog from board ${String(BOARD_ID)}...`);
  const backlog = await fetchBacklog(authHeader);
  console.log(`  ${String(backlog.length)} issues in backlog\n`);

  if (backlog.length <= 1) {
    console.log('Nothing to sort.');
    return;
  }

  console.log(`  (${String(backlog.length)} total, filtering epics next)`);

  // 2. Filter out epics
  const epics = backlog.filter((i) => i.fields.issuetype?.name === 'Epic');
  const issues = backlog.filter((i) => i.fields.issuetype?.name !== 'Epic');
  if (epics.length > 0) {
    console.log(
      `  Skipping ${String(epics.length)} epic(s) — not included in sort\n`,
    );
  }

  // 3. Count by priority
  const counts = new Map<string, number>();
  for (const issue of issues) {
    const p = getPriorityName(issue) ?? '(none)';
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  console.log(`Sorting ${String(issues.length)} non-epic issues.\n`);
  console.log('Priority distribution:');
  for (const p of PRIORITY_ORDER) {
    const label = p ?? '(none)';
    const count = counts.get(label) ?? 0;
    if (count > 0) console.log(`  ${label}: ${String(count)}`);
  }
  // Any priorities not in our known list
  for (const [p, c] of counts) {
    if (!PRIORITY_ORDER.includes(p === '(none)' ? null : p)) {
      console.log(`  ${p}: ${String(c)} (unknown — sorted just before Lowest)`);
    }
  }
  console.log();

  // 4. Stable-sort
  const sorted = stableSortByPriority(issues);
  const currentKeys = issues.map((i) => i.key);
  const sortedKeys = sorted.map((i) => i.key);

  // 5. Check if already sorted
  const alreadySorted = currentKeys.every((k, i) => k === sortedKeys[i]);
  if (alreadySorted) {
    console.log('✅ Backlog is already sorted by priority. No changes needed.');
    return;
  }

  // Show what would change
  let firstDiff = -1;
  let diffCount = 0;
  for (let i = 0; i < currentKeys.length; i++) {
    if (currentKeys[i] !== sortedKeys[i]) {
      if (firstDiff === -1) firstDiff = i;
      diffCount++;
    }
  }
  console.log(
    `${String(diffCount)} of ${String(currentKeys.length)} issues will change position (first diff at rank ${String(firstDiff + 1)}).\n`,
  );

  // 6. Re-rank
  if (!live) {
    console.log('[dry-run] Preview of new top-10:');
    for (let i = 0; i < Math.min(10, sorted.length); i++) {
      const s = sorted[i];
      const p = getPriorityName(s) ?? '(none)';
      console.log(
        `  ${String(i + 1)}. ${s.key} [${p}] ${s.fields.summary ?? ''}`,
      );
    }
    console.log();
  }

  const calls = await rerank(authHeader, sortedKeys, live);

  if (live) {
    console.log(`✅ Backlog re-ranked. ${String(calls)} API call(s).`);
  } else {
    console.log(
      `[dry-run] Would make ~${String(Math.ceil(sortedKeys.length / RANK_BATCH_SIZE))} API call(s). Run with --live to apply.`,
    );
  }
}

main().catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exit(1);
});
