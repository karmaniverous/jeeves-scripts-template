/**
 * @module openclaw-db/open-agent-db
 *
 * Opens the OpenClaw agent SQLite store READ-ONLY and resolves the pinned
 * schema module for its `PRAGMA user_version`. An unsupported version
 * throws (never guesses). Reads run inside one read transaction so a scan
 * sees a consistent WAL snapshot; a busy timeout tolerates writer locks.
 */

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { schemaV23 } from './schema-v23.js';
import type { OpenClawDbSchema, SchemaContext } from './types.js';

/** Schema modules by `user_version`. Add schema-vNN here on upgrade. */
const SCHEMAS: Record<number, OpenClawDbSchema> = {
  [schemaV23.version]: schemaV23,
};

/** Thrown when the agent DB's schema version has no reader. */
export class OpenClawSchemaMismatchError extends Error {
  constructor(
    readonly dbPath: string,
    readonly found: number,
  ) {
    super(
      `[token-metrics] OpenClaw agent DB schema mismatch at ${dbPath}: expected user_version ${Object.keys(SCHEMAS).join(' or ')}, found ${String(found)}. ` +
        'Add a schema module (src/admin/lib/openclaw-db/schema-vNN.ts) and follow the upgrade runbook; refusing to guess.',
    );
    this.name = 'OpenClawSchemaMismatchError';
  }
}

/** An open, read-only agent DB bound to its schema reader. */
export interface AgentDb {
  db: DatabaseSync;
  schema: OpenClawDbSchema;
  ctx: SchemaContext;
  close: () => void;
}

/**
 * Open the agent DB read-only and bind its schema module.
 *
 * @param dbPath - `.../agents/<id>/agent/openclaw-agent.sqlite`
 * @throws OpenClawSchemaMismatchError when user_version is unsupported
 */
export function openAgentDb(dbPath: string): AgentDb {
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 15_000 });
  try {
    const row = db.prepare('PRAGMA user_version').get() as
      { user_version: number } | undefined;
    const found = row?.user_version ?? 0;
    const schema = SCHEMAS[found] as OpenClawDbSchema | undefined;
    if (!schema) throw new OpenClawSchemaMismatchError(dbPath, found);

    db.exec('BEGIN');
    // OpenClaw keeps session artifacts in the sibling `sessions/` dir.
    const agentDir = path.dirname(dbPath);
    const artifactDir =
      path.basename(agentDir) === 'agent'
        ? path.join(path.dirname(agentDir), 'sessions')
        : agentDir;
    return {
      db,
      schema,
      ctx: { artifactDir },
      close: () => {
        if (db.isTransaction) db.exec('COMMIT');
        db.close();
      },
    };
  } catch (err) {
    db.close();
    throw err;
  }
}
