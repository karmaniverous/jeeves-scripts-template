/**
 * @module rate-card-pending
 *
 * The pending-models file hands model ids from collect-token-metrics to
 * refresh-token-rates. The collector can't pass arguments through the
 * runner trigger, so it records the ids it found missing from the rate
 * card here; the refresh job adds each one once OpenRouter returns valid
 * prices and rewrites the file with whatever is still unresolved.
 *
 * Format: a JSON array of model-id strings. A missing, unreadable or
 * malformed file reads as empty (the collector re-records unknown models
 * on its next run, so nothing is lost for good).
 */

import fs from 'node:fs';

import { atomicWrite } from '@karmaniverous/jeeves';

/**
 * Read pending model ids.
 *
 * @param filePath - Pending file path.
 * @returns Unique non-empty ids, in file order; [] when absent or invalid.
 */
export function readPendingModels(filePath: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ids = parsed.filter(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  );
  return [...new Set(ids)];
}

/**
 * Replace the pending ids. An empty list removes the file.
 *
 * @param filePath - Pending file path.
 * @param ids - Ids to keep pending.
 */
export function writePendingModels(filePath: string, ids: string[]): void {
  const unique = [...new Set(ids)];
  if (!unique.length) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  atomicWrite(filePath, `${JSON.stringify(unique, null, 2)}\n`);
}

/**
 * Merge ids into the pending file (keeps existing entries).
 *
 * @param filePath - Pending file path.
 * @param ids - Ids to add.
 */
export function addPendingModels(filePath: string, ids: string[]): void {
  writePendingModels(filePath, [...readPendingModels(filePath), ...ids]);
}
