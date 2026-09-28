/**
 * @module openclaw-db/test-fixture-v23
 *
 * Test-only builder for an OpenClaw agent DB using the REAL schema-23 DDL
 * (test-fixture-v23-ddl.ts) for the tables token metrics reads. Sessions
 * default to key `agent:main:test:<id>` with an empty entry; pass a
 * {@link FixtureNode} to record real-shaped channel metadata. Writes a scratch SQLite file plus cold-archive files; used by the
 * openclaw-db tests. Never touches a live store.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';

import { V23_DDL } from './test-fixture-v23-ddl.js';

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

/** Session node metadata for a fixture session. */
export interface FixtureNode {
  /** Session key (default `agent:main:test:<id>`). */
  key?: string;
  /** `session_nodes.entry_json` object. */
  entry?: Record<string, unknown>;
  /** `session_nodes.label`. */
  label?: string;
  /** Live transcript generation (`transcript_rewrite_watermarks`). */
  generation?: string;
}

/** Handle to a fixture DB under `<root>/agent/openclaw-agent.sqlite`. */
export interface V23Fixture {
  dbPath: string;
  sessionsDir: string;
  db: DatabaseSync;
  /** Add a live session with hot rows; `zstdSeqs` are stored compressed. */
  addHotSession: (
    id: string,
    events: string[],
    zstdSeqs?: number[],
    node?: FixtureNode,
  ) => void;
  /** Add a conversation row (native channel id + label). */
  addConversation: (nativeChannelId: string, label: string) => void;
  /** Add a cold-archived session (file storage under sessions/cold/). */
  addColdSession: (id: string, events: string[]) => void;
  /** Add a deleted/reset transcript archive (zstd JSONL, header first). */
  addArchive: (
    id: string,
    events: string[],
    reason?: 'deleted' | 'reset',
    generation?: string,
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

  const addWindow = (id: string, node: FixtureNode = {}) => {
    const key = node.key ?? `agent:main:test:${id}`;
    db.prepare(
      'INSERT OR IGNORE INTO session_nodes (session_key, current_session_id, entry_json, label, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(key, id, JSON.stringify(node.entry ?? {}), node.label ?? null, now);
    db.prepare(
      'INSERT INTO session_windows (session_id, session_key, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run(id, key, now, now);
    if (node.generation)
      db.prepare(
        'INSERT INTO transcript_rewrite_watermarks (session_id, generation, updated_at) VALUES (?, ?, ?)',
      ).run(id, node.generation, now);
  };

  return {
    dbPath,
    sessionsDir,
    db,
    addConversation: (nativeChannelId, label) => {
      db.prepare(
        "INSERT INTO conversations (conversation_id, channel, account_id, kind, peer_id, delivery_target, native_channel_id, label, created_at, updated_at) VALUES (?, 'slack', 'default', 'channel', ?, ?, ?, ?, ?, ?)",
      ).run(
        `conv-${nativeChannelId}`,
        nativeChannelId,
        `channel:${nativeChannelId}`,
        nativeChannelId,
        label,
        now,
        now,
      );
    },
    addHotSession: (id, events, zstdSeqs = [], node) => {
      addWindow(id, node);
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
    addArchive: (id, events, reason = 'deleted', generation = 'g1') => {
      const bytes = zstd(Buffer.from(events.join('\n') + '\n'));
      db.prepare(
        "INSERT INTO session_transcript_archives (session_id, generation, session_key, reason, encoding, archive_blob, archive_sha256, archive_name, created_at) VALUES (?, ?, ?, ?, 'zstd', ?, ?, ?, ?)",
      ).run(
        id,
        generation,
        `agent:main:test:${id}`,
        reason,
        bytes,
        sha256(bytes),
        `${id}.jsonl.${reason}.${generation}.zst`,
        now,
      );
    },
    close: () => {
      db.close();
    },
  };
}
