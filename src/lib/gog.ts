/**
 * @module gog
 *
 * Google Workspace CLI wrapper — retry-aware invocation of the gog
 * binary for Gmail and Calendar operations.
 *
 * Called by email/poll.ts, email/download.ts, and calendar/poll.ts.
 * Defaults GOG_HOME to GOG_CONFIG_DIR so gog (and every child process
 * it spawns) reads the same home the scripts read: the directory
 * jeeves-tools provisions. An explicit GOG_HOME (set by the gateway unit
 * and the runner drop-in on managed instances) is left untouched.
 *
 * Config dependencies: GOG_BIN, GOG_CONFIG_DIR from constants.ts.
 */

import { runWithRetry } from '@karmaniverous/jeeves';

import { GOG_BIN, GOG_CONFIG_DIR } from './constants.js';

export const GOG = GOG_BIN;

process.env.GOG_HOME ??= GOG_CONFIG_DIR;

/**
 * Run a gog command with retry logic for transient network errors.
 */
export function gogWithRetry(
  args: string[],
  opts: { retries?: number; backoffMs?: number } = {},
): string {
  return runWithRetry(GOG, args, {
    retries: opts.retries ?? 2,
    backoffMs: opts.backoffMs ?? 5000,
    isRetryable: (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      return /context deadline exceeded|timed out|timeout/i.test(msg);
    },
  });
}
