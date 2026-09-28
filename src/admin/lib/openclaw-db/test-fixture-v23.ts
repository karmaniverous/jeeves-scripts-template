/**
 * @module openclaw-db/test-fixture-v23
 *
 * Test-only builder for an OpenClaw agent DB using the REAL schema-23 DDL
 * (copied verbatim from a 2026.9.6 host) for the tables token metrics
 * reads. Writes a scratch SQLite file plus cold-archive files; used by the
 * openclaw-db tests. Never touches a live store.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';

/** Schema-23 DDL (verbatim from `sqlite_master`). */
const V23_DDL = `
CREATE TABLE conversations (
  conversation_id TEXT NOT NULL PRIMARY KEY,
  channel TEXT NOT NULL,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'group', 'channel')),
  peer_id TEXT NOT NULL,
  delivery_target TEXT NOT NULL,
  parent_conversation_id TEXT,
  thread_id TEXT,
  native_channel_id TEXT,
  native_direct_user_id TEXT,
  label TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE session_nodes (
  session_key TEXT NOT NULL PRIMARY KEY,
  current_session_id TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  legacy_acp_migration_json TEXT,
  entry_valid INTEGER NOT NULL DEFAULT 0 CHECK (entry_valid IN (-1, 0, 1)),
  updated_at INTEGER NOT NULL,
  status TEXT CHECK (status IS NULL OR status IN ('running', 'done', 'failed', 'killed', 'timeout')),
  created_at INTEGER,
  created_via TEXT CHECK (created_via IS NULL OR created_via IN ('operator', 'spawn', 'channel', 'cron', 'talk', 'run', 'plugin', 'internal')),
  created_actor_type TEXT CHECK (created_actor_type IS NULL OR created_actor_type IN ('human', 'agent', 'system')),
  created_actor_id TEXT,
  owner_actor_type TEXT,
  owner_actor_id TEXT,
  owner_assigned_by_type TEXT,
  owner_assigned_by_id TEXT,
  owner_assigned_at INTEGER,
  project_id TEXT,
  parent_session_key TEXT,
  spawned_by TEXT,
  fork_source_session_key TEXT,
  fork_source_session_id TEXT,
  fork_source_entry_id TEXT,
  label TEXT,
  display_name TEXT,
  category TEXT,
  icon TEXT,
  pinned_at INTEGER,
  archived_at INTEGER,
  last_read_at INTEGER,
  last_interaction_at INTEGER,
  last_activity_at INTEGER
) STRICT;
CREATE TABLE session_windows (
  session_id TEXT NOT NULL PRIMARY KEY,
  session_key TEXT NOT NULL,
  previous_session_id TEXT,
  reason TEXT CHECK (reason IS NULL OR reason IN ('initial', 'reset', 'rollover', 'fork', 'rewind', 'switch', 'recovery', 'compaction')),
  session_scope TEXT NOT NULL DEFAULT 'conversation' CHECK (session_scope IN ('conversation', 'shared-main', 'group', 'channel')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  transcript_updated_at INTEGER DEFAULT NULL,
  transcript_observed_at INTEGER DEFAULT NULL,
  session_entry_provenance INTEGER NOT NULL DEFAULT 0 CHECK (session_entry_provenance IN (0, 1)),
  acp_owned INTEGER NOT NULL DEFAULT 0 CHECK (acp_owned IN (0, 1)),
  plugin_owner_id TEXT,
  hook_external_content_source TEXT CHECK (hook_external_content_source IS NULL OR hook_external_content_source IN ('gmail', 'webhook')),
  started_at INTEGER,
  ended_at INTEGER,
  status TEXT CHECK (status IS NULL OR status IN ('running', 'done', 'failed', 'killed', 'timeout')),
  chat_type TEXT CHECK (chat_type IS NULL OR chat_type IN ('direct', 'group', 'channel')),
  channel TEXT,
  account_id TEXT,
  primary_conversation_id TEXT,
  model_provider TEXT,
  model TEXT,
  agent_harness_id TEXT,
  parent_session_key TEXT,
  spawned_by TEXT,
  display_name TEXT,
  FOREIGN KEY (session_key) REFERENCES session_nodes(session_key) ON DELETE CASCADE,
  FOREIGN KEY (primary_conversation_id) REFERENCES conversations(conversation_id) ON DELETE SET NULL
) STRICT;
CREATE TABLE "transcript_events" (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_json TEXT,
  created_at INTEGER NOT NULL,
  event_zstd BLOB,
  event_utf8_bytes INTEGER CHECK (event_utf8_bytes IS NULL OR event_utf8_bytes >= 0),
  navigation_json TEXT,
  PRIMARY KEY (session_id, seq),
  FOREIGN KEY (session_id) REFERENCES "session_windows"(session_id) ON DELETE CASCADE,
  CHECK (
    (event_json IS NOT NULL AND event_zstd IS NULL)
    OR (
      event_json IS NULL AND event_zstd IS NOT NULL
      AND event_utf8_bytes IS NOT NULL
      AND event_utf8_bytes BETWEEN 1 AND 4194304
      AND length(event_zstd) BETWEEN 1 AND 4194304
      AND navigation_json IS NOT NULL
    )
  ),
  CHECK (
    navigation_json IS NULL OR CASE WHEN json_valid(navigation_json) THEN coalesce(
      octet_length(navigation_json) <= 16384
      AND json_type(navigation_json, '$.version') = 'integer'
      AND json_extract(navigation_json, '$.version') = 1
      AND json_type(navigation_json, '$.report') = 'object'
      AND json_extract(navigation_json, '$.report.kind') IN ('canonical', 'leaf', 'link', 'ignored')
      AND json_type(navigation_json, '$.navigation') = 'object'
      AND json_type(navigation_json, '$.reset') = 'object'
      AND json_type(navigation_json, '$.model') = 'object'
      AND json_type(navigation_json, '$.modelBytes') = 'integer'
      AND json_extract(navigation_json, '$.modelBytes') BETWEEN 0 AND 4194304
      AND json_type(navigation_json, '$.modelWithoutCheckpointBytes') = 'integer'
      AND json_extract(navigation_json, '$.modelWithoutCheckpointBytes') BETWEEN 0 AND 4194304
      AND json_type(navigation_json, '$.withoutCustomDataBytes') = 'integer'
      AND json_extract(navigation_json, '$.withoutCustomDataBytes') BETWEEN 0 AND 4194304,
      0) ELSE 0 END
  )
) STRICT;
CREATE TABLE session_transcript_archives (
  session_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  session_key TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('deleted', 'reset')),
  encoding TEXT NOT NULL CHECK (encoding IN ('identity', 'zstd')),
  archive_blob BLOB NOT NULL,
  archive_sha256 TEXT NOT NULL CHECK (length(archive_sha256) = 64),
  archive_name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  publish_attempts INTEGER NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
  last_publish_attempt_at INTEGER,
  last_publish_error TEXT,
  PRIMARY KEY (session_id, generation),
  CHECK (archive_name NOT LIKE '%/%' AND archive_name NOT LIKE '%\\%')
) STRICT;
CREATE TABLE session_transcript_cold_archives (
  session_id TEXT NOT NULL PRIMARY KEY,
  generation TEXT NOT NULL,
  archive_name TEXT NOT NULL UNIQUE,
  archive_sha256 TEXT NOT NULL CHECK (length(archive_sha256) = 64),
  event_count INTEGER NOT NULL CHECK (event_count >= 1),
  raw_bytes INTEGER NOT NULL CHECK (raw_bytes >= 0),
  archive_bytes INTEGER NOT NULL CHECK (archive_bytes >= 0),
  last_seq INTEGER NOT NULL,
  archived_at INTEGER NOT NULL,
  storage TEXT NOT NULL CHECK (storage IN ('file', 'sqlite')),
  archive_blob BLOB,
  FOREIGN KEY (session_id) REFERENCES "session_windows"(session_id) ON DELETE CASCADE,
  CHECK (length(archive_name) > 0 AND archive_name NOT IN ('.', '..') AND archive_name NOT LIKE '%/%' AND archive_name NOT LIKE '%\\%'),
  CHECK ((storage = 'file' AND archive_blob IS NULL) OR (storage = 'sqlite' AND archive_blob IS NOT NULL))
) STRICT;
`;

/** Valid navigation_json for compressed rows (required by the v23 CHECK). */
const NAVIGATION_JSON = JSON.stringify({
  version: 1,
  report: { kind: 'ignored' },
  navigation: {},
  reset: {},
  model: {},
  modelBytes: 0,
  modelWithoutCheckpointBytes: 0,
  withoutCustomDataBytes: 0,
});

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const zstd = (b: Uint8Array) =>
  zlib.zstdCompressSync(b, {
    params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
  });

/** Handle to a fixture DB under `<root>/agent/openclaw-agent.sqlite`. */
export interface V23Fixture {
  dbPath: string;
  sessionsDir: string;
  db: DatabaseSync;
  /** Add a live session with hot rows; `zstdSeqs` are stored compressed. */
  addHotSession: (id: string, events: string[], zstdSeqs?: number[]) => void;
  /** Add a cold-archived session (file storage under sessions/cold/). */
  addColdSession: (id: string, events: string[]) => void;
  /** Add a deleted/reset transcript archive (zstd JSONL, header first). */
  addArchive: (
    id: string,
    events: string[],
    reason?: 'deleted' | 'reset',
  ) => void;
  close: () => void;
}

/** Create a schema-23 fixture DB (`userVersion` overrides the pragma). */
export function createV23Fixture(root: string, userVersion = 23): V23Fixture {
  const agentDir = path.join(root, 'agent');
  const sessionsDir = path.join(root, 'sessions');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(sessionsDir, 'cold'), { recursive: true });
  const dbPath = path.join(agentDir, 'openclaw-agent.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(V23_DDL);
  db.exec(`PRAGMA user_version = ${String(userVersion)}`);
  const now = Date.now();

  const addWindow = (id: string) => {
    const key = `agent:main:test:${id}`;
    db.prepare(
      'INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)',
    ).run(key, id, '{}', now);
    db.prepare(
      'INSERT INTO session_windows (session_id, session_key, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run(id, key, now, now);
  };

  return {
    dbPath,
    sessionsDir,
    db,
    addHotSession: (id, events, zstdSeqs = []) => {
      addWindow(id);
      const insert = db.prepare(
        'INSERT INTO transcript_events (session_id, seq, event_json, created_at, event_zstd, event_utf8_bytes, navigation_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      events.forEach((json, seq) => {
        const bytes = Buffer.from(json, 'utf8');
        if (zstdSeqs.includes(seq))
          insert.run(
            id,
            seq,
            null,
            now,
            zstd(bytes),
            bytes.length,
            NAVIGATION_JSON,
          );
        else insert.run(id, seq, json, now, null, bytes.length, null);
      });
    },
    addColdSession: (id, events) => {
      addWindow(id);
      const records = [
        { kind: 'header', version: 1, sessionId: id, generation: 'g1' },
        ...events.map((event_json, seq) => ({
          kind: 'event',
          row: { seq, event_json, created_at: now },
        })),
      ];
      const bytes = zstd(
        Buffer.from(records.map((r) => JSON.stringify(r)).join('\n') + '\n'),
      );
      const hash = sha256(bytes);
      const name = `${hash}.jsonl.zst`;
      fs.writeFileSync(path.join(sessionsDir, 'cold', name), bytes);
      db.prepare(
        "INSERT INTO session_transcript_cold_archives (session_id, generation, archive_name, archive_sha256, event_count, raw_bytes, archive_bytes, last_seq, archived_at, storage) VALUES (?, 'g1', ?, ?, ?, ?, ?, ?, ?, 'file')",
      ).run(
        id,
        name,
        hash,
        events.length,
        0,
        bytes.length,
        events.length - 1,
        now,
      );
    },
    addArchive: (id, events, reason = 'deleted') => {
      const bytes = zstd(Buffer.from(events.join('\n') + '\n'));
      db.prepare(
        "INSERT INTO session_transcript_archives (session_id, generation, session_key, reason, encoding, archive_blob, archive_sha256, archive_name, created_at) VALUES (?, 'g1', ?, ?, 'zstd', ?, ?, ?, ?)",
      ).run(
        id,
        `agent:main:test:${id}`,
        reason,
        bytes,
        sha256(bytes),
        `${id}.jsonl.${reason}.zst`,
        now,
      );
    },
    close: () => {
      db.close();
    },
  };
}
