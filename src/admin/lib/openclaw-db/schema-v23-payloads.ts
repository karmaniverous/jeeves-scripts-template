/**
 * @module openclaw-db/schema-v23-payloads
 *
 * Schema-23 payload decoding and integrity checks (split from
 * schema-v23.ts): hot `transcript_events` rows (`event_json` text or a
 * checksummed zstd frame whose decoded size is `event_utf8_bytes`), cold
 * archives (zstd JSONL of `{kind, row}` records, file or blob, verified by
 * byte length + sha256 and record metadata) and deleted/reset transcript
 * archives (JSONL with a session header line, identity or zstd encoded,
 * sha256-verified; line index = seq). Pure over its inputs; read-only.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import type { SchemaContext, TranscriptEvent } from './types.js';

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

/** One `session_transcript_cold_archives` row. */
export interface ColdRow {
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

/** Read and verify a cold archive's events. */
export function readColdEvents(
  row: ColdRow,
  ctx: SchemaContext,
): TranscriptEvent[] {
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

/** One `session_transcript_archives` row (payload columns). */
export interface ArchiveRow {
  session_id: string;
  archive_name: string;
  encoding: string;
  archive_blob: Uint8Array;
  archive_sha256: string;
}

/** Read and verify a deleted/reset transcript archive's events. */
export function readArchiveEvents(row: ArchiveRow): TranscriptEvent[] {
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
