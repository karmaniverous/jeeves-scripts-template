#!/usr/bin/env tsx
/**
 * @module poll-bookmarks
 *
 * Polls bookmarks via X API v2 for every handle in X_ACCOUNTS, or only the
 * handle given as the first argument.
 *
 * Entry-point script invoked by the runner scheduler. Delegates to
 * poll-x-items with the pollBookmarks API function, enqueuing results
 * into the x-bookmarks-{handle} runner queue for drain-queues to flush to disk.
 */

import { runXPoller } from './lib/poll-x-items.js';
import { pollBookmarks } from './lib/x-api.js';

runXPoller('x/poll-bookmarks', {
  pollFn: pollBookmarks,
  queuePrefix: 'x-bookmarks',
  typeLabel: 'bookmarks',
});
