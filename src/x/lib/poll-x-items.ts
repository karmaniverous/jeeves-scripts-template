/**
 * @module poll-x-items
 *
 * Shared poller for X/Twitter items via X API v2.
 *
 * Called by each poll-* entry-point script with a specific API poll function
 * and queue prefix. Fetches items through x-api, then enqueues them into the
 * jeeves-runner queue for downstream processing by drain-queues.
 *
 * With no handle argument every handle in `X_ACCOUNTS` is polled (see
 * poll-handles.ts); `<handle>` narrows the run to one handle.
 */

import fs from 'node:fs';

import { getArg, runScript } from '@karmaniverous/jeeves';
import type { RunnerClient } from '@karmaniverous/jeeves-runner';
import { getRunnerClient } from '@karmaniverous/jeeves-runner';
import type { Client } from '@xdevplatform/xdk';

import { X_ACCOUNTS } from '../../lib/constants.js';
import { logPollHandles, resolvePollHandles } from './poll-handles.js';
import type { PollOptions, XTweet } from './x-api.js';
import { getOAuthPath, withAutoRefresh } from './x-api.js';

export { type XTweet } from './x-api.js';

export interface PollXOptions {
  /** API poll function to call */
  pollFn: (
    client: Client,
    handle: string,
    options?: PollOptions,
  ) => Promise<XTweet[]>;
  /** Queue name prefix, e.g. 'x-posts' or 'x-mentions' */
  queuePrefix: string;
  /** Type label for logging and queue payloads */
  typeLabel: string;
  /** Default count of items to fetch */
  defaultCount?: number;
}

/**
 * Run a parameterized X poll: fetch items via API, enqueue to runner.
 *
 * @param handle - The X account handle to poll for.
 * @param options - Poll configuration (API function, queue prefix, etc.).
 */
export async function pollXItems(
  handle: string,
  options: PollXOptions,
): Promise<void> {
  const argv = process.argv.slice(2);
  const count = Number(
    getArg(argv, '--count', String(options.defaultCount ?? 50)),
  );
  const queueName = getArg(argv, '--queue', `${options.queuePrefix}-${handle}`);

  let tweets: XTweet[];
  try {
    tweets = await withAutoRefresh(handle, (client) =>
      options.pollFn(client, handle, { maxResults: count }),
    );
  } catch (err) {
    console.error(
      `${options.typeLabel}: API error for @${handle}:`,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  if (!tweets.length) {
    console.log(`${options.typeLabel}: no items returned for @${handle}`);
    return;
  }

  const runnerClient: RunnerClient = getRunnerClient();
  try {
    let enqueued = 0,
      dedupSkipped = 0;
    for (const t of tweets) {
      const itemId = runnerClient.enqueue(queueName, {
        id: t.id,
        createdAt: t.createdAt,
        author: t.authorId ?? handle,
        type: options.typeLabel,
        text: t.text,
        raw: t,
      });
      if (itemId === -1) dedupSkipped++;
      else enqueued++;
    }

    console.log(
      `${options.typeLabel}: @${handle} fetched=${String(tweets.length)}, enqueued=${String(enqueued)}, dedupSkipped=${String(dedupSkipped)}`,
    );
  } finally {
    runnerClient.close();
  }
}

/**
 * Handles this run polls: the first CLI argument if given, else every
 * handle in `X_ACCOUNTS`; only handles with an OAuth file. Logs a
 * `[skip]` line for each handle left out.
 */
export function pollHandlesFromArgv(): string[] {
  return logPollHandles(
    resolvePollHandles(process.argv[2], X_ACCOUNTS, (h) =>
      fs.existsSync(getOAuthPath(h)),
    ),
  );
}

/**
 * Entry-point wrapper for X poll scripts: resolves the handles
 * ({@link pollHandlesFromArgv}) and polls each in turn. An API error for
 * one handle is logged and the next handle is still polled; any other
 * error fails the run (runScript exits 1).
 */
export function runXPoller(scriptName: string, options: PollXOptions): void {
  runScript(scriptName, async () => {
    for (const handle of pollHandlesFromArgv())
      await pollXItems(handle, options);
  });
}
