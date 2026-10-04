#!/usr/bin/env tsx
/**
 * @module poll-feed
 *
 * Polls the home timeline via X API v2 for every handle in X_ACCOUNTS, or
 * only the handle given as the first argument (see lib/poll-handles.ts).
 *
 * Entry-point script invoked by the runner scheduler. Unlike other pollers,
 * writes feed items directly to each account's feed/ directory on disk and
 * prunes entries older than seven days. A failure for one handle is logged,
 * the remaining handles are still polled, and the run then fails.
 *
 * Uses {@link X_ACCOUNTS} from constants to resolve each account base directory.
 */

import fs from 'node:fs';
import path from 'node:path';

import { runScript } from '@karmaniverous/jeeves';

import { X_ACCOUNTS } from '../lib/constants.js';
import { pollHandlesFromArgv } from './lib/poll-x-items.js';
import type { XTweet } from './lib/x-api.js';
import { pollHomeTimeline, withAutoRefresh } from './lib/x-api.js';

const PRUNE_DAYS = 7;

function writeFeedItems(
  feedDir: string,
  tweets: XTweet[],
  source: string,
): { written: number; skipped: number } {
  let written = 0,
    skipped = 0;
  for (const t of tweets) {
    if (!t.id) continue;
    const filePath = path.join(feedDir, `${t.id}.json`);
    if (fs.existsSync(filePath)) {
      skipped++;
      continue;
    }
    const entry = {
      ...t,
      _feedSource: source,
      _ingestedAt: new Date().toISOString(),
    };
    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2) + '\n', 'utf8');
    written++;
  }
  return { written, skipped };
}

function pruneOldFiles(feedDir: string): number {
  const cutoff = Date.now() - PRUNE_DAYS * 86400000;
  let pruned = 0;
  for (const file of fs.readdirSync(feedDir)) {
    if (!file.endsWith('.json')) continue;
    const stat = fs.statSync(path.join(feedDir, file));
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(path.join(feedDir, file));
      pruned++;
    }
  }
  return pruned;
}

async function pollFeed(handle: string): Promise<void> {
  const feedDir = path.join(X_ACCOUNTS[handle], 'feed');
  fs.mkdirSync(feedDir, { recursive: true });

  const tweets = await withAutoRefresh(handle, (client) =>
    pollHomeTimeline(client, handle, { maxResults: 100 }),
  );

  const result = writeFeedItems(feedDir, tweets, 'timeline');
  const pruned = pruneOldFiles(feedDir);

  console.log(
    `feed: @${handle} fetched=${String(tweets.length)} (new=${String(result.written)}, dedup=${String(result.skipped)}), pruned=${String(pruned)}`,
  );
}

runScript('x/poll-feed', async () => {
  // One handle failing does not stop the others; the run still fails.
  const failed: string[] = [];
  for (const handle of pollHandlesFromArgv()) {
    try {
      await pollFeed(handle);
    } catch (err) {
      console.error(
        `poll-feed: @${handle} failed:`,
        err instanceof Error ? err.message : String(err),
      );
      failed.push(handle);
    }
  }
  if (failed.length > 0)
    throw new Error(`poll-feed failed for @${failed.join(', @')}`);
});
