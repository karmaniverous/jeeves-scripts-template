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
 * Channel metadata OpenClaw records for a session (session key plus the
 * names from its origin/delivery context), used to name the channel
 * instead of guessing from transcript text.
 */
export interface SessionMeta {
  /** Full session key, e.g. `agent:main:slack:channel:c0abc123`. */
  sessionKey: string;
  /** Session label (subagents, cron jobs). */
  label?: string;
  /** Channel/group display name, e.g. `#ops-ceo`. */
  channelName?: string;
  /** Direct-message counterpart's display name. */
  peerName?: string;
  /** Metadata of the spawning session (one level). */
  parent?: SessionMeta;
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
  /** Channel metadata, when the store records it for this transcript. */
  meta?: SessionMeta;
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
