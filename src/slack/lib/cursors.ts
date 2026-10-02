/**
 * @module slack/lib/cursors
 *
 * Slack poller read positions (the newest seen `ts` per channel).
 *
 * Read positions are instance STATE, not config: losing them only means
 * the next poll re-reads history (message files are deduped by `ts`).
 * They live in a JSON state file keyed by channel ID
 * (`{ "<channelId>": "<lastTs>" }`), never in the committed, curated
 * `channels.json`. See karmaniverous/jeeves-tools#184 for the
 * config/state classification.
 *
 * Migration: a channel with no state entry falls back once to a legacy
 * `lastTs` still present in `channels.json`. The migrated positions are
 * saved to the state file before `channels.json` is rewritten without
 * them, so the fallback happens at most once.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Read position per channel ID. */
export type Cursors = Record<string, string>;

/** A `channels.json` entry: curated metadata plus a possible legacy `lastTs`. */
export interface ChannelEntry {
  name?: unknown;
  lastTs?: unknown;
}

/** Write a file atomically: write a sibling temp file, then rename over. */
export function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${String(process.pid)}.tmp`;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Load read positions from the state file; a missing file is empty state. */
export function loadCursors(stateFile: string): Cursors {
  if (!fs.existsSync(stateFile)) return {};
  const parsed: unknown = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Slack cursor state is not a JSON object: ${stateFile}`);
  }
  const cursors: Cursors = {};
  for (const [id, ts] of Object.entries(parsed)) {
    if (typeof ts === 'string' && ts !== '') cursors[id] = ts;
  }
  return cursors;
}

/** Save read positions to the state file (atomic). */
export function saveCursors(stateFile: string, cursors: Cursors): void {
  writeFileAtomic(stateFile, `${JSON.stringify(cursors, null, 2)}\n`);
}

/**
 * Seed `cursors` from legacy `lastTs` values in `channels` for channels
 * without a state entry. State always wins; `'0'` (never polled) is not
 * migrated. Returns the number of positions migrated.
 */
export function migrateLegacyCursors(
  cursors: Cursors,
  channels: Record<string, ChannelEntry>,
): number {
  let migrated = 0;
  for (const [id, info] of Object.entries(channels)) {
    if (id in cursors) continue;
    const legacy = info.lastTs;
    if (typeof legacy === 'string' && legacy !== '' && legacy !== '0') {
      cursors[id] = legacy;
      migrated++;
    }
  }
  return migrated;
}

/** Write `channels.json` (atomic) with every `lastTs` stripped. */
export function saveChannels<T extends ChannelEntry>(
  channelsFile: string,
  channels: Record<string, T>,
): void {
  const stripped: Record<string, T> = {};
  for (const [id, info] of Object.entries(channels)) {
    const entry: T = { ...info };
    delete entry.lastTs;
    stripped[id] = entry;
  }
  writeFileAtomic(channelsFile, `${JSON.stringify(stripped, null, 2)}\n`);
}

/**
 * Load read positions for a poll run: the state file, plus a one-time
 * migration of legacy `lastTs` values from `channels`. Migrated positions
 * are persisted immediately, before anything rewrites `channels.json`.
 */
export function loadPollCursors(
  stateFile: string,
  channels: Record<string, ChannelEntry>,
): { cursors: Cursors; migrated: number } {
  const cursors = loadCursors(stateFile);
  const migrated = migrateLegacyCursors(cursors, channels);
  if (migrated > 0) saveCursors(stateFile, cursors);
  return { cursors, migrated };
}
