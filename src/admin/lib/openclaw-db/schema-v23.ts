/**
 * @module openclaw-db/schema-v23
 *
 * ALL knowledge of OpenClaw agent-DB schema 23 (OpenClaw 2026.9.x) used by
 * token metrics: table/column names, payload encodings and integrity checks.
 * Read-only. Enumerates each session's full transcript history from:
 * - `transcript_events` hot rows (`event_json` text, or a checksummed zstd
 *   frame in `event_zstd` whose decoded size is `event_utf8_bytes`);
 * - `session_transcript_cold_archives` (zstd JSONL of `{kind, row}`
 *   records, stored as a `sessions/cold/<sha>.jsonl.zst` file or a blob;
 *   verified by byte length + sha256 and record metadata);
 * - `session_transcript_archives` (deleted/reset transcripts: JSONL with a
 *   session header line, identity or zstd encoded, sha256-verified; line
 *   index = seq, matching the hot table where seq starts at 0).
 * A future schema adds schema-vNN.ts beside this file; do not edit this one.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';

import type {
  OpenClawDbSchema,
  SchemaContext,
  TranscriptEvent,
  TranscriptRef,
} from './types.js';

/** Largest decoded payload OpenClaw writes for one event (4 MiB). */
const MAX_EVENT_BYTES = 4_194_304;

/** Upper bound for a decoded archive (guards zstd bombs). */
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function zstd(bytes: Uint8Array, maxOutputLength: number): Buffer {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error(
      'OpenClaw schema 23 stores zstd payloads, but this Node.js runtime lacks zlib.zstdDecompressSync',
    );
  }
  // zstd verifies the frame's content checksum while decoding.
  return zlib.zstdDecompressSync(bytes, { maxOutputLength });
}

/** Decode one transcript_events row to its JSON text. */
export function decodeEventRow(row: {
  event_json: string | null;
  event_zstd: Uint8Array | null;
  event_utf8_bytes: number | null;
}): string {
  if (row.event_json !== null) return row.event_json;
  const bytes = row.event_utf8_bytes;
  if (!row.event_zstd || bytes === null || bytes < 1 || bytes > MAX_EVENT_BYTES)
    throw new Error('Invalid compressed transcript payload bounds');
  const decoded = zstd(row.event_zstd, bytes);
  if (decoded.byteLength !== bytes)
    throw new Error(
      'Compressed transcript payload length does not match event_utf8_bytes',
    );
  return decoded.toString('utf8');
}

interface ColdRow {
  session_id: string;
  generation: string;
  archive_name: string;
  archive_sha256: string;
  event_count: number;
  archive_bytes: number;
  last_seq: number;
  storage: string;
  archive_blob: Uint8Array | null;
}

function readColdEvents(row: ColdRow, ctx: SchemaContext): TranscriptEvent[] {
  let bytes: Uint8Array;
  if (row.storage === 'sqlite') {
    if (!row.archive_blob) throw new Error('Cold archive blob missing');
    bytes = row.archive_blob;
  } else {
    if (!/^[a-f0-9]{64}\.jsonl\.zst$/.test(row.archive_name))
      throw new Error(`Invalid cold archive name ${row.archive_name}`);
    bytes = fs.readFileSync(
      path.join(ctx.artifactDir, 'cold', row.archive_name),
    );
  }
  if (
    bytes.length !== row.archive_bytes ||
    sha256(bytes) !== row.archive_sha256
  )
    throw new Error(`Cold archive ${row.archive_name} failed verification`);

  const records = zstd(bytes, MAX_ARCHIVE_BYTES)
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          kind?: unknown;
          sessionId?: unknown;
          row?: { seq?: unknown; event_json?: unknown };
        },
    );
  const header = records[0] as (typeof records)[number] | undefined;
  if (header?.kind !== 'header' || header.sessionId !== row.session_id)
    throw new Error(`Cold archive ${row.archive_name} header mismatch`);

  const events: TranscriptEvent[] = [];
  for (const record of records) {
    if (record.kind !== 'event') continue;
    const { seq, event_json: json } = record.row ?? {};
    if (typeof seq !== 'number' || typeof json !== 'string')
      throw new Error(`Cold archive ${row.archive_name} has a malformed event`);
    events.push({ seq, json });
  }
  if (events.length !== row.event_count || events.at(-1)?.seq !== row.last_seq)
    throw new Error(`Cold archive ${row.archive_name} metadata mismatch`);
  return events;
}

interface ArchiveRow {
  session_id: string;
  archive_name: string;
  encoding: string;
  archive_blob: Uint8Array;
  archive_sha256: string;
}

function readArchiveEvents(row: ArchiveRow): TranscriptEvent[] {
  if (sha256(row.archive_blob) !== row.archive_sha256)
    throw new Error(
      `Transcript archive ${row.archive_name} failed verification`,
    );
  const text = (
    row.encoding === 'zstd'
      ? zstd(row.archive_blob, MAX_ARCHIVE_BYTES)
      : Buffer.from(row.archive_blob)
  ).toString('utf8');
  const lines = text.split('\n').filter((line) => line.trim());
  const header =
    lines.length > 0
      ? (JSON.parse(lines[0]) as { type?: unknown; id?: unknown })
      : undefined;
  if (header?.type !== 'session' || header.id !== row.session_id)
    throw new Error(`Transcript archive ${row.archive_name} header mismatch`);
  return lines.map((json, seq) => ({ seq, json }));
}

function listTranscripts(
  db: DatabaseSync,
  ctx: SchemaContext,
): TranscriptRef[] {
  const sessions = new Map<
    string,
    { hotMax?: number; cold?: ColdRow; archives: string[] }
  >();
  const entry = (id: string) => {
    let e = sessions.get(id);
    if (!e) {
      e = { archives: [] };
      sessions.set(id, e);
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

  const archives = db
    .prepare(
      'SELECT session_id, archive_name FROM session_transcript_archives ORDER BY created_at, archive_name',
    )
    .all() as { session_id: string; archive_name: string }[];
  for (const r of archives) entry(r.session_id).archives.push(r.archive_name);

  const eventsStmt = db.prepare(
    'SELECT seq, event_json, event_zstd, event_utf8_bytes FROM transcript_events WHERE session_id = ? ORDER BY seq',
  );
  const archiveStmt = db.prepare(
    'SELECT session_id, archive_name, encoding, archive_blob, archive_sha256 FROM session_transcript_archives WHERE archive_name = ?',
  );

  return [...sessions].map(([sessionId, e]) => ({
    cursorKey: `session:${sessionId}`,
    maxSeq:
      e.archives.length > 0
        ? undefined
        : Math.max(e.hotMax ?? -1, e.cold?.last_seq ?? -1),
    load: () => {
      const bySeq = new Map<number, string>();
      for (const name of e.archives) {
        const row = archiveStmt.get(name) as unknown as ArchiveRow;
        for (const ev of readArchiveEvents(row)) bySeq.set(ev.seq, ev.json);
      }
      if (e.cold)
        for (const ev of readColdEvents(e.cold, ctx))
          bySeq.set(ev.seq, ev.json);
      if (e.hotMax !== undefined) {
        const rows = eventsStmt.all(sessionId) as unknown as (Parameters<
          typeof decodeEventRow
        >[0] & { seq: number })[];
        for (const r of rows) bySeq.set(r.seq, decodeEventRow(r));
      }
      return [...bySeq]
        .sort((a, b) => a[0] - b[0])
        .map(([seq, json]) => ({ seq, json }));
    },
  }));
}

/** OpenClaw agent-DB schema 23 reader. */
export const schemaV23: OpenClawDbSchema = { version: 23, listTranscripts };
