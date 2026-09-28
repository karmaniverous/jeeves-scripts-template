/**
 * @module bucket-io
 *
 * Hourly bucket file I/O — read, write, and path computation
 * for token-metrics hourly rollup files.
 *
 * Called by collect-token-metrics (write) and token-metrics (read).
 * Each bucket file is an immutable JSON snapshot of one UTC hour.
 *
 * Config dependencies: TOKEN_METRICS_DIR from constants.ts.
 */

import path from 'node:path';

import { readJson, writeJsonAtomic } from '@karmaniverous/jeeves';

import { TOKEN_METRICS_DIR } from '../../lib/constants.js';
import type {
  HourlyBucket,
  HourlyModelEntry,
  HourlyTokenEntry,
  TokenCategory,
} from '../types/token-metrics.js';
import { TOKEN_CATEGORIES } from '../types/token-metrics.js';

/**
 * Compute the ISO hour string from a Unix-millisecond timestamp.
 * Returns format `YYYY-MM-DDTHH` (UTC).
 */
export function tsToHour(tsMs: number): string {
  const d = new Date(tsMs);
  const y = String(d.getUTCFullYear());
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  return [y, '-', m, '-', day, 'T', h].join('');
}

/**
 * Compute the start-of-current-UTC-hour as Unix-millisecond timestamp.
 */
export function currentHourBoundaryMs(): number {
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  return now.getTime();
}

/**
 * Compute the filesystem path for an hourly bucket file.
 *
 * Layout: `{base}/{YYYY}/{MM}/{YYYY-MM-DDTHH}.json`
 */
export function bucketPath(
  hour: string,
  baseDir: string = TOKEN_METRICS_DIR,
): string {
  const yyyy = hour.substring(0, 4);
  const mm = hour.substring(5, 7);
  return path.join(baseDir, yyyy, mm, hour + '.json');
}

/**
 * Read an hourly bucket from disk. Returns null if the file doesn't exist.
 */
export function readBucket(
  hour: string,
  baseDir: string = TOKEN_METRICS_DIR,
): HourlyBucket | null {
  return readJson<HourlyBucket | null>(bucketPath(hour, baseDir), null);
}

/**
 * Write an hourly bucket to disk atomically.
 */
export function writeBucket(
  bucket: HourlyBucket,
  baseDir: string = TOKEN_METRICS_DIR,
): void {
  writeJsonAtomic(bucketPath(bucket.hour, baseDir), bucket);
}

/**
 * Create an empty token entry.
 */
function emptyTokenEntry(): HourlyTokenEntry {
  return { count: 0, cost: 0 };
}

/**
 * Create an empty model entry with zeroed token categories.
 */
export function emptyModelEntry(): HourlyModelEntry {
  return {
    input: emptyTokenEntry(),
    output: emptyTokenEntry(),
    cacheRead: emptyTokenEntry(),
    cacheWrite: emptyTokenEntry(),
  };
}

/**
 * Get or initialize a channel entry within a bucket.
 */
function getOrCreateChannel(
  bucket: HourlyBucket,
  channel: string,
): { models: Record<string, HourlyModelEntry> } {
  const existing = bucket.channels[channel] as
    HourlyBucket['channels'][string] | undefined;
  if (existing) return existing;
  const entry = { models: {} as Record<string, HourlyModelEntry> };
  bucket.channels[channel] = entry;
  return entry;
}

/**
 * Get or initialize a model entry within a channel.
 */
function getOrCreateModel(
  models: Record<string, HourlyModelEntry>,
  model: string,
): HourlyModelEntry {
  const existing = models[model] as HourlyModelEntry | undefined;
  if (existing) return existing;
  const entry = emptyModelEntry();
  models[model] = entry;
  return entry;
}

/**
 * Merge a single usage record into an in-memory bucket map.
 */
export function mergeUsage(
  buckets: Map<string, HourlyBucket>,
  hour: string,
  channel: string,
  model: string,
  usage: Record<TokenCategory, { count: number; cost: number }>,
): void {
  let bucket = buckets.get(hour);
  if (!bucket) {
    bucket = { hour, channels: {} };
    buckets.set(hour, bucket);
  }

  const chanEntry = getOrCreateChannel(bucket, channel);
  const modelEntry = getOrCreateModel(chanEntry.models, model);

  for (const cat of TOKEN_CATEGORIES) {
    modelEntry[cat].count += usage[cat].count;
    modelEntry[cat].cost += usage[cat].cost;
  }
}

/**
 * Deep-merge a freshly-computed bucket into an existing on-disk bucket.
 * Returns the merged result.
 */
export function mergeBuckets(
  existing: HourlyBucket,
  incoming: HourlyBucket,
): HourlyBucket {
  const merged: HourlyBucket = {
    hour: existing.hour,
    channels: { ...existing.channels },
  };

  for (const [chanKey, inChan] of Object.entries(incoming.channels)) {
    const mergedChan = getOrCreateChannel(merged, chanKey);

    for (const [modelKey, inModel] of Object.entries(inChan.models)) {
      const mergedModel = getOrCreateModel(mergedChan.models, modelKey);

      for (const cat of TOKEN_CATEGORIES) {
        mergedModel[cat].count += inModel[cat].count;
        mergedModel[cat].cost += inModel[cat].cost;
      }
    }
  }

  return merged;
}

/**
 * Flush in-memory buckets to disk. For each bucket:
 * - Read existing file (if any)
 * - Deep-merge
 * - Write atomically
 *
 * @param baseDir - Bucket root (defaults to TOKEN_METRICS_DIR)
 * @returns Number of bucket files written
 */
export function flushBuckets(
  buckets: Map<string, HourlyBucket>,
  baseDir: string = TOKEN_METRICS_DIR,
): number {
  let written = 0;
  for (const [hour, bucket] of buckets) {
    const existing = readBucket(hour, baseDir);
    const final = existing ? mergeBuckets(existing, bucket) : bucket;
    writeBucket(final, baseDir);
    written++;
  }
  return written;
}
