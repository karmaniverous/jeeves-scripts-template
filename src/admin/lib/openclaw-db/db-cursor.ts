/**
 * @module openclaw-db/db-cursor
 *
 * Incremental cursor for the agent-DB scanner: per transcript key, the
 * highest seq whose event has been handled (counted or skipped). Events
 * with seq <= lastSeq are never counted again, so runs don't double count.
 * Stored as JSON in runner state (TOKEN_METRICS_DB_CURSOR_KEY).
 */

import { z } from 'zod';

/** Cursor for one transcript. */
export const dbTranscriptCursorSchema = z.object({
  /** Highest handled seq (-1 = nothing handled). */
  lastSeq: z.number().int(),
  /** Largest counted usage timestamp (ms), informational. */
  lastTimestamp: z.number(),
});

/** Cursor map keyed by transcript key (`session:<id>`, `legacy:<file>`). */
export const dbCursorStateSchema = z.record(
  z.string(),
  dbTranscriptCursorSchema,
);

/** Parsed DB cursor state. */
export type DbCursorState = z.infer<typeof dbCursorStateSchema>;

/**
 * Parse raw runner state. Returns null when no cursor has been stored yet
 * (the store must be bootstrapped with regenerate-token-metrics).
 */
export function parseDbCursorState(raw: string | null): DbCursorState | null {
  if (raw === null) return null;
  return dbCursorStateSchema.parse(JSON.parse(raw));
}
