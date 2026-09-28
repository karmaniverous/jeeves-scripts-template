/**
 * @module openclaw-db/schema-v23
 *
 * ALL knowledge of OpenClaw agent-DB schema 23 (OpenClaw 2026.9.x) used by
 * token metrics: table/column names and how transcripts are assembled.
 * Payload decoding/verification lives in schema-v23-payloads.ts; channel
 * metadata (session keys and names) in schema-v23-meta.ts. Read-only.
 *
 * Transcripts, per session id:
 * - live: `transcript_events` hot rows plus the session's
 *   `session_transcript_cold_archives` row, merged by seq (one generation;
 *   the current one is `transcript_rewrite_watermarks.generation`). Cursor
 *   key `session:<id>`.
 * - archived: each `session_transcript_archives` row, keyed
 *   `(session_id, generation)`, is its OWN immutable transcript (seq
 *   restarts at 0 per generation; never merged by seq). Cursor key
 *   `session:<id>#<generation>`. OpenClaw archives the live transcript on
 *   delete/reset, so an archive seeds from the `session:<id>` cursor when
 *   that cursor was stamped with the archive's generation (or is unstamped,
 *   the session has no live rows left and this is its newest archive):
 *   events already counted live are not counted again.
 * Archives are listed first so they read the live cursor before a new
 * generation's live scan restamps it.
 * A future schema adds schema-vNN.ts beside this file; do not edit this one.
 */

import type { DatabaseSync } from 'node:sqlite';

import { loadV23Meta } from './schema-v23-meta.js';
import type { ArchiveRow, ColdRow } from './schema-v23-payloads.js';
import {
  decodeEventRow,
  readArchiveEvents,
  readColdEvents,
} from './schema-v23-payloads.js';
import type {
  OpenClawDbSchema,
  SchemaContext,
  TranscriptEvent,
  TranscriptRef,
} from './types.js';

interface LiveSession {
  hotMax?: number;
  cold?: ColdRow;
}

interface ArchiveListRow {
  session_id: string;
  generation: string;
  session_key: string;
  archive_name: string;
}

type HotRow = Parameters<typeof decodeEventRow>[0] & { seq: number };

function listLive(db: DatabaseSync): Map<string, LiveSession> {
  const live = new Map<string, LiveSession>();
  const entry = (id: string) => {
    let e = live.get(id);
    if (!e) {
      e = {};
      live.set(id, e);
    }
    return e;
  };
  const hot = db
    .prepare(
      'SELECT session_id, MAX(seq) AS max_seq FROM transcript_events GROUP BY session_id',
    )
    .all() as { session_id: string; max_seq: number }[];
  for (const r of hot) entry(r.session_id).hotMax = r.max_seq;
  const cold = db
    .prepare(
      'SELECT session_id, generation, archive_name, archive_sha256, event_count, archive_bytes, last_seq, storage, archive_blob FROM session_transcript_cold_archives',
    )
    .all() as unknown as ColdRow[];
  for (const r of cold) entry(r.session_id).cold = r;
  return live;
}

function liveGenerations(db: DatabaseSync): Map<string, string> {
  const rows = db
    .prepare('SELECT session_id, generation FROM transcript_rewrite_watermarks')
    .all() as { session_id: string; generation: string }[];
  return new Map(rows.map((r) => [r.session_id, r.generation]));
}

function listTranscripts(
  db: DatabaseSync,
  ctx: SchemaContext,
): TranscriptRef[] {
  const live = listLive(db);
  const generations = liveGenerations(db);
  const meta = loadV23Meta(db);
  const archives = db
    .prepare(
      'SELECT session_id, generation, session_key, archive_name FROM session_transcript_archives ORDER BY session_id, created_at, generation',
    )
    .all() as unknown as ArchiveListRow[];
  const archived = new Map<string, Set<string>>();
  const newest = new Map<string, string>();
  for (const a of archives) {
    const set = archived.get(a.session_id) ?? new Set<string>();
    archived.set(a.session_id, set.add(a.generation));
    newest.set(a.session_id, a.generation);
  }

  const archiveStmt = db.prepare(
    'SELECT session_id, archive_name, encoding, archive_blob, archive_sha256 FROM session_transcript_archives WHERE session_id = ? AND generation = ?',
  );
  const eventsStmt = db.prepare(
    'SELECT seq, event_json, event_zstd, event_utf8_bytes FROM transcript_events WHERE session_id = ? ORDER BY seq',
  );

  const archiveRefs: TranscriptRef[] = archives.map((a) => ({
    cursorKey: `session:${a.session_id}#${a.generation}`,
    generation: a.generation,
    immutable: true,
    seed: {
      key: `session:${a.session_id}`,
      acceptUnstamped:
        !live.has(a.session_id) && newest.get(a.session_id) === a.generation,
    },
    meta: meta.forSession(a.session_id) ?? meta.forKey(a.session_key),
    maxSeq: undefined,
    load: () =>
      readArchiveEvents(
        archiveStmt.get(a.session_id, a.generation) as unknown as ArchiveRow,
      ),
  }));

  const liveRefs: TranscriptRef[] = [...live].map(([sessionId, e]) => ({
    cursorKey: `session:${sessionId}`,
    generation: generations.get(sessionId) ?? e.cold?.generation,
    retiredGenerations: archived.get(sessionId),
    meta: meta.forSession(sessionId),
    maxSeq: Math.max(e.hotMax ?? -1, e.cold?.last_seq ?? -1),
    load: () => {
      const bySeq = new Map<number, string>();
      if (e.cold)
        for (const ev of readColdEvents(e.cold, ctx))
          bySeq.set(ev.seq, ev.json);
      if (e.hotMax !== undefined)
        for (const r of eventsStmt.all(sessionId) as unknown as HotRow[])
          bySeq.set(r.seq, decodeEventRow(r));
      return [...bySeq]
        .sort((x, y) => x[0] - y[0])
        .map(([seq, json]): TranscriptEvent => ({ seq, json }));
    },
  }));

  return [...archiveRefs, ...liveRefs];
}

/** OpenClaw agent-DB schema 23 reader. */
export const schemaV23: OpenClawDbSchema = { version: 23, listTranscripts };
