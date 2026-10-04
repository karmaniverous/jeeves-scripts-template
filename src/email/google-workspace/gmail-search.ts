/**
 * @module gmail-search
 *
 * Validated parsing and paging of `gog gmail search --json` output.
 *
 * gog prints one page as `{ threads: ThreadItem[], nextPageToken }`,
 * where each item carries `id`, `date`, `from`, `subject`, `labels` and
 * `messageCount` (older builds also emit `threadId`, `snippet`, `to`).
 * The page is parsed with a Zod schema at this boundary, so malformed
 * output fails before any thread is processed instead of being cast and
 * half-applied.
 *
 * Called by email/poll.ts and email/google-workspace/backfill-window.ts.
 */

import { z } from 'zod';

const ThreadItemSchema = z.object({
  id: z.string().nullish(),
  threadId: z.string().nullish(),
  subject: z.string().nullish(),
  snippet: z.string().nullish(),
  from: z.string().nullish(),
  to: z.string().nullish(),
  date: z.string().nullish(),
  messageCount: z.number().nullish(),
  labels: z.array(z.string()).nullish(),
});

const SearchPageSchema = z.object({
  threads: z.array(ThreadItemSchema).nullish(),
  nextPageToken: z.string().nullish(),
});

/** One thread from a search page, normalised. */
export interface ThreadSummary {
  threadId: string;
  subject: string;
  snippet: string;
  from: string;
  to: string;
  date: string | null;
  messageCount: number | null;
  labels: string[];
}

/** One parsed search page. */
export interface SearchPage {
  /** Threads with an id; items without one are dropped. */
  threads: ThreadSummary[];
  /** Token for the next page; empty when this is the last page. */
  nextPageToken: string;
}

/**
 * Parse one `gog gmail search --json` page. Empty output is an empty
 * last page.
 *
 * @param out - gog stdout.
 * @param context - Included in the error message (e.g. the account).
 * @throws When the output is not JSON or does not match the schema.
 */
export function parseSearchPage(out: string, context: string): SearchPage {
  if (!out) return { threads: [], nextPageToken: '' };
  const parsed = SearchPageSchema.safeParse(JSON.parse(out));
  if (!parsed.success) {
    throw new Error(
      `Unexpected gog gmail search output for ${context}: ${z.prettifyError(parsed.error)}`,
    );
  }
  const threads: ThreadSummary[] = [];
  for (const t of parsed.data.threads ?? []) {
    const threadId = t.threadId || t.id || '';
    if (!threadId) continue;
    threads.push({
      threadId,
      subject: t.subject ?? '',
      snippet: t.snippet ?? '',
      from: t.from ?? '',
      to: t.to ?? '',
      date: t.date || null,
      messageCount: t.messageCount ?? null,
      labels: t.labels ?? [],
    });
  }
  return { threads, nextPageToken: parsed.data.nextPageToken ?? '' };
}

/** Runs a gog command and returns stdout. */
export type GogRunner = (args: string[]) => string;

/** `gog gmail search` arguments for one page. */
export function searchArgs(
  account: string,
  query: string,
  pageSize: number,
  pageToken?: string,
): string[] {
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
  if (pageToken) args.push('--page', pageToken);
  return args;
}

/**
 * Yield search pages for `query`, following `nextPageToken` until it is
 * empty. Pages are fetched lazily, so callers process one page at a
 * time and memory stays bounded by the page size.
 *
 * @throws When gog repeats a page token (instead of looping forever).
 */
export function* searchThreadPages(
  gog: GogRunner,
  account: string,
  query: string,
  pageSize: number,
): Generator<ThreadSummary[]> {
  const seenTokens = new Set<string>();
  let token: string | undefined;
  for (;;) {
    const page = parseSearchPage(
      gog(searchArgs(account, query, pageSize, token)),
      account,
    );
    yield page.threads;
    if (!page.nextPageToken) return;
    if (seenTokens.has(page.nextPageToken)) {
      throw new Error(`gog returned a repeated page token for ${account}`);
    }
    seenTokens.add(page.nextPageToken);
    token = page.nextPageToken;
  }
}
