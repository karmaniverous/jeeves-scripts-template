/**
 * @module slack/lib/cursors
 *
 * Slack poller read positions (the newest seen `ts` per channel).
 *
 * Read positions are instance STATE, not config
 * (karmaniverous/jeeves-tools#184). Like the other pollers (calendar
 * `lastSync-<email>`, github `watch-<user>`), they live in the
 * jeeves-runner state store: namespace `slack`, one scalar key per
 * channel, `lastTs-<channelId>`. They are never written to the
 * committed, curated `channels.json`.
 *
 * Absent state means "read the channel from the beginning". An
 * unreachable store is an error: the poll run fails rather than
 * silently re-reading every channel.
 *
 * Migration: a channel with no stored position falls back once to a
 * legacy `lastTs` still present in `channels.json`. The migrated
 * position is written to the store before `channels.json` is rewritten
 * without it, so the fallback happens at most once.
 */

import fs from 'node:fs';

import type { RunnerClient } from '@karmaniverous/jeeves-runner';

/** Runner state namespace for Slack poller state. */
export const SLACK_STATE_NAMESPACE = 'slack';

/** Runner state key holding a channel's read position. */
export function cursorKey(channelId: string): string {
  return `lastTs-${channelId}`;
}

/** Read position per channel ID. */
export type Cursors = Record<string, string>;

/** A `channels.json` entry: curated metadata plus a possible legacy `lastTs`. */
export interface ChannelEntry {
  name?: unknown;
  lastTs?: unknown;
}

/** Persist one channel's read position to the runner state store. */
export function saveCursor(
  client: RunnerClient,
  channelId: string,
  ts: string,
): void {
  client.setState(SLACK_STATE_NAMESPACE, cursorKey(channelId), ts);
}

/**
 * Load read positions for every channel in `channels` from the runner
 * state store. A channel with no stored position but a legacy `lastTs`
 * in `channels.json` is migrated: the value is written to the store
 * immediately (before anything rewrites `channels.json`). `'0'` (never
 * polled) is not migrated. Channels with neither are absent from the
 * result and are read from the beginning.
 *
 * @throws If the store cannot be read or written.
 */
export function loadPollCursors(
  client: RunnerClient,
  channels: Record<string, ChannelEntry>,
): { cursors: Cursors; migrated: number } {
  const cursors: Cursors = {};
  let migrated = 0;
  try {
    for (const [id, info] of Object.entries(channels)) {
      const stored = client.getState(SLACK_STATE_NAMESPACE, cursorKey(id));
      if (stored) {
        cursors[id] = stored;
        continue;
      }
      const legacy = info.lastTs;
      if (typeof legacy === 'string' && legacy !== '' && legacy !== '0') {
        saveCursor(client, id, legacy);
        cursors[id] = legacy;
        migrated++;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Slack read positions unavailable: runner state store error (${msg}). Aborting poll.`,
      { cause: err },
    );
  }
  return { cursors, migrated };
}

/** Write `channels.json` with every `lastTs` stripped. */
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
  fs.writeFileSync(channelsFile, JSON.stringify(stripped, null, 2), 'utf8');
}
