/**
 * @module fresh-openclaw-history
 *
 * Decides whether a host with no OpenClaw DB cursor has never counted any
 * OpenClaw usage, so collect-token-metrics can start the DB cursor empty
 * (count from the start of OpenClaw's history) instead of refusing.
 *
 * A host has counted OpenClaw usage, and must be bootstrapped with
 * regenerate-token-metrics, when either holds:
 * - the legacy JSONL cursor (TOKEN_METRICS_CURSOR_KEY) has an entry;
 * - a bucket file (or a recalc/regen backup of one) under the bucket root
 *   holds a channel that is not a Claude Code `cc:` channel, or can't be
 *   read (counted as OpenClaw usage, to stay safe).
 * Claude Code buckets don't count: a fresh host writes them on the runs
 * where the DB collector refused.
 */

import fs from 'node:fs';
import path from 'node:path';

import { readJson } from '@karmaniverous/jeeves';

import { TOKEN_METRICS_DIR } from '../../lib/constants.js';
import type { CursorState, HourlyBucket } from '../types/token-metrics.js';
import { CC_CHANNEL_PREFIX } from './claude-code-scanner.js';

/** Child directory names matching `pattern` (none when `dir` is absent). */
function subdirs(dir: string, pattern: RegExp): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && pattern.test(e.name))
    .map((e) => path.join(dir, e.name));
}

/** True when the bucket file holds OpenClaw usage or can't be read. */
function holdsOpenClawUsage(file: string): boolean {
  const bucket = readJson<HourlyBucket | null>(file, null);
  if (!bucket || typeof bucket.channels !== 'object') return true;
  return Object.keys(bucket.channels).some(
    (key) => !key.startsWith(CC_CHANNEL_PREFIX),
  );
}

/**
 * Whether any bucket file under `{baseDir}/{YYYY}/{MM}/` holds OpenClaw
 * usage. Stops at the first one found.
 */
export function hasOpenClawBuckets(
  baseDir: string = TOKEN_METRICS_DIR,
): boolean {
  for (const year of subdirs(baseDir, /^\d{4}$/))
    for (const month of subdirs(year, /^\d{2}$/))
      for (const name of fs.readdirSync(month))
        if (
          name.endsWith('.json') &&
          holdsOpenClawUsage(path.join(month, name))
        )
          return true;
  return false;
}

/**
 * Whether OpenClaw usage has never been counted on this host: no legacy
 * cursor entry and no bucket holding OpenClaw usage (checked lazily, only
 * when the legacy cursor is empty).
 */
export function isFreshOpenClawHistory(
  legacyCursors: CursorState,
  openClawBucketsExist: () => boolean,
): boolean {
  return Object.keys(legacyCursors).length === 0 && !openClawBucketsExist();
}
