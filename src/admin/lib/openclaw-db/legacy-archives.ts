/**
 * @module openclaw-db/legacy-archives
 *
 * Pre-2026.9 reset/deleted transcript files left in SESSIONS_DIR. The
 * 2026.9 migration imported live transcripts into the agent DB but left
 * these archives on disk, so full history = agent DB + these files. They
 * are immutable; seq = line index. Published `.zst` copies of DB archives
 * are excluded (the DB archive table is their source of truth).
 */

import fs from 'node:fs';
import path from 'node:path';

import type { TranscriptRef } from './types.js';

/** True for legacy reset/deleted transcript archive filenames. */
export function isLegacyArchiveName(name: string): boolean {
  return (
    (name.includes('.jsonl.deleted.') || name.includes('.jsonl.reset.')) &&
    !name.endsWith('.zst')
  );
}

/** List legacy archives in `sessionsDir` (empty when the dir is absent). */
export function listLegacyArchives(sessionsDir: string): TranscriptRef[] {
  if (!fs.existsSync(sessionsDir)) return [];
  return fs
    .readdirSync(sessionsDir)
    .filter(isLegacyArchiveName)
    .sort()
    .map((name) => ({
      cursorKey: `legacy:${name}`,
      maxSeq: undefined,
      immutable: true,
      load: () =>
        fs
          .readFileSync(path.join(sessionsDir, name), 'utf8')
          .split('\n')
          .map((json, seq) => ({ seq, json }))
          .filter((ev) => ev.json.trim()),
    }));
}
