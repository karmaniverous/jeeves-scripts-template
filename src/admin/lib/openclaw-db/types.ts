/**
 * @module openclaw-db/types
 *
 * Version-neutral contract between the token-metrics DB scanner and a
 * schema module (schema-v23.ts, later schema-v24.ts, ...). A schema module
 * owns every table, column and encoding detail; the scanner only sees
 * transcripts as ordered (seq, JSON line) events.
 */

import type { DatabaseSync } from 'node:sqlite';

/** One decoded transcript event: its sequence number and JSON text. */
export interface TranscriptEvent {
  seq: number;
  json: string;
}

/**
 * A transcript available for scanning. `maxSeq` lets the scanner skip
 * fully-processed transcripts without decoding them (undefined = unknown
 * until loaded). `load` decodes and returns events ordered by seq.
 */
export interface TranscriptRef {
  cursorKey: string;
  maxSeq: number | undefined;
  load: () => TranscriptEvent[];
}

/** Paths a schema module may need besides the open database. */
export interface SchemaContext {
  /** Directory holding OpenClaw session artifacts (`sessions/`). */
  artifactDir: string;
}

/** A pinned OpenClaw agent-DB schema reader. */
export interface OpenClawDbSchema {
  /** `PRAGMA user_version` this module understands. */
  version: number;
  /** Enumerate every transcript (hot, cold and deleted/reset archives). */
  listTranscripts: (db: DatabaseSync, ctx: SchemaContext) => TranscriptRef[];
}
