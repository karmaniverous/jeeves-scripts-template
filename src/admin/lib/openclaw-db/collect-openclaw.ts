/**
 * @module openclaw-db/collect-openclaw
 *
 * Incremental OpenClaw collection step for collect-token-metrics on a
 * 2026.9+ host: loads the DB cursor from runner state, scans the agent DB
 * up to the cutoff, and returns the updated cursor for the caller to save
 * AFTER buckets are flushed. Without a stored cursor it refuses (returns
 * null and sets a non-zero exit code): counting from zero would double
 * count history the JSONL collector already wrote. Bootstrap with
 * regenerate-token-metrics --from <upgrade hour>.
 */

import type { HourlyBucket } from '../../types/token-metrics.js';
import type { DbCursorState } from './db-cursor.js';
import { parseDbCursorState } from './db-cursor.js';
import { scanOpenClawDb } from './scan-openclaw-db.js';

/** Inputs for the incremental OpenClaw DB step. */
export interface CollectOpenClawParams {
  dbPath: string;
  sessionsDir: string;
  rawCursor: string | null;
  cutoffMs: number;
  buckets: Map<string, HourlyBucket>;
  seenModels: Set<string>;
}

/**
 * Run the incremental OpenClaw DB scan.
 *
 * @returns the advanced cursor, or null when collection was refused
 * @throws OpenClawSchemaMismatchError on an unsupported DB schema
 */
export function collectOpenClawDb(
  params: CollectOpenClawParams,
): DbCursorState | null {
  const cursors = parseDbCursorState(params.rawCursor);
  if (!cursors) {
    console.error(
      '[token-metrics] No OpenClaw DB cursor in runner state; refusing to collect OpenClaw usage from zero (it would double count history). ' +
        'Bootstrap once with: tsx src/admin/regenerate-token-metrics.ts --from <OpenClaw 2026.9 upgrade hour, ISO>',
    );
    process.exitCode = 1;
    return null;
  }

  const stats = scanOpenClawDb({
    dbPath: params.dbPath,
    sessionsDir: params.sessionsDir,
    cursors,
    options: { fromMs: 0, toMs: params.cutoffMs },
    buckets: params.buckets,
    seenModels: params.seenModels,
  });
  console.log(
    `[token-metrics] OpenClaw DB (schema ${String(stats.schemaVersion)}): ${String(stats.transcriptsProcessed)} transcripts processed, ${String(stats.transcriptsSkipped)} skipped, ${String(stats.usageCounted)} usage events`,
  );
  return cursors;
}
