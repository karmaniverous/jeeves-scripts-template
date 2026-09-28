/**
 * Tests for the schema-23 reader and read-only open: hot rows (plain and
 * zstd), a cold archive file, a deleted archive, integrity failures and a
 * wrong-schema DB (must fail loudly).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openAgentDb, OpenClawSchemaMismatchError } from './open-agent-db.js';
import { createV23Fixture } from './test-fixture-v23.js';

const header = (id: string) =>
  JSON.stringify({ type: 'session', version: 3, id });
const msg = (id: string, text: string) =>
  JSON.stringify({
    type: 'message',
    id,
    message: { role: 'user', content: text },
  });

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-db-v23-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function loadAll(dbPath: string) {
  const agentDb = openAgentDb(dbPath);
  try {
    return agentDb.schema
      .listTranscripts(agentDb.db, agentDb.ctx)
      .map((t) => ({ key: t.cursorKey, maxSeq: t.maxSeq, events: t.load() }))
      .sort((a, b) => a.key.localeCompare(b.key));
  } finally {
    agentDb.close();
  }
}

describe('schema v23 reader', () => {
  it('reads hot (plain + zstd), cold and deleted-archive transcripts', () => {
    const fx = createV23Fixture(root);
    fx.addHotSession(
      'hot',
      [header('hot'), msg('a', 'plain'), msg('b', 'x'.repeat(500))],
      [2],
    );
    fx.addColdSession('cold', [header('cold'), msg('c', 'cold one')]);
    fx.addArchive('gone', [header('gone'), msg('d', 'deleted one')]);
    fx.close();

    const all = loadAll(fx.dbPath);
    expect(all.map((t) => t.key)).toEqual([
      'session:cold',
      'session:gone',
      'session:hot',
    ]);
    const hot = all[2];
    expect(hot.maxSeq).toBe(2);
    expect(hot.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(hot.events[2].json).toContain('x'.repeat(500));
    expect(all[0].events[1].json).toContain('cold one');
    expect(all[0].maxSeq).toBe(1);
    expect(all[1].maxSeq).toBeUndefined();
    expect(all[1].events.map((e) => e.seq)).toEqual([0, 1]);
    expect(all[1].events[1].json).toContain('deleted one');
  });

  it('rejects a tampered cold archive file', () => {
    const fx = createV23Fixture(root);
    fx.addColdSession('cold', [header('cold'), msg('c', 'cold one')]);
    fx.close();
    const coldDir = path.join(fx.sessionsDir, 'cold');
    const [name] = fs.readdirSync(coldDir);
    fs.appendFileSync(path.join(coldDir, name), 'junk');

    expect(() => loadAll(fx.dbPath)).toThrow(/failed verification/);
  });

  it('rejects a deleted archive whose hash does not match', () => {
    const fx = createV23Fixture(root);
    fx.addArchive('gone', [header('gone')]);
    fx.db.exec(
      `UPDATE session_transcript_archives SET archive_sha256 = '${'0'.repeat(64)}'`,
    );
    fx.close();

    expect(() => loadAll(fx.dbPath)).toThrow(/failed verification/);
  });

  it('fails loudly on a wrong schema version, naming expected and found', () => {
    const fx = createV23Fixture(root, 22);
    fx.close();

    expect(() => openAgentDb(fx.dbPath)).toThrow(OpenClawSchemaMismatchError);
    expect(() => openAgentDb(fx.dbPath)).toThrow(
      /expected user_version 23, found 22/,
    );
  });

  it('opens read-only', () => {
    const fx = createV23Fixture(root);
    fx.close();
    const agentDb = openAgentDb(fx.dbPath);
    try {
      expect(() => {
        agentDb.db.exec('CREATE TABLE nope (x INTEGER)');
      }).toThrow(/readonly/i);
    } finally {
      agentDb.close();
    }
  });
});
