/**
 * @module openclaw-db/scan-openclaw-db
 *
 * Entry point for OpenClaw usage from the 2026.9+ agent SQLite store:
 * opens the DB read-only (schema-pinned; throws on an unknown version),
 * enumerates hot/cold/archived transcripts plus legacy reset/deleted files
 * in SESSIONS_DIR, and scans them into hourly buckets. Never writes.
 */

import type { HourlyBucket } from '../../types/token-metrics.js';
import type { DbCursorState } from './db-cursor.js';
import type { DbScanOptions, DbScanStats } from './db-scanner.js';
import { scanTranscripts } from './db-scanner.js';
import { listLegacyArchives } from './legacy-archives.js';
import { openAgentDb } from './open-agent-db.js';

/** Inputs for one OpenClaw DB scan. */
export interface ScanOpenClawDbParams {
  dbPath: string;
  sessionsDir: string;
  cursors: DbCursorState;
  options: DbScanOptions;
  buckets: Map<string, HourlyBucket>;
  seenModels: Set<string>;
}

/**
 * Scan OpenClaw usage from the agent DB into `buckets`.
 *
 * @returns scan counters plus the schema version that was read
 */
export function scanOpenClawDb(
  params: ScanOpenClawDbParams,
): DbScanStats & { schemaVersion: number } {
  const agentDb = openAgentDb(params.dbPath);
  try {
    const transcripts = [
      ...agentDb.schema.listTranscripts(agentDb.db, agentDb.ctx),
      ...listLegacyArchives(params.sessionsDir),
    ];
    const stats = scanTranscripts(
      transcripts,
      params.cursors,
      params.options,
      params.buckets,
      params.seenModels,
    );
    return { ...stats, schemaVersion: agentDb.schema.version };
  } finally {
    agentDb.close();
  }
}
