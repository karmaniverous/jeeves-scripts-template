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
 * silently re-reading every channel. A position that is present but is
 * not a Slack timestamp (stored or legacy) is also an error.
 *
 * Migration: a channel with no stored position falls back once to a
 * legacy `lastTs` still present in `channels.json`. The migrated
 * position is written to the store before `channels.json` is rewritten
 * without it, so the fallback happens at most once.
 */

import fs from 'node:fs';

import type { RunnerClient } from '@karmaniverous/jeeves-runner';
import { z } from 'zod';

/** Runner state namespace for Slack poller state. */
export const SLACK_STATE_NAMESPACE = 'slack';

/** Runner state key holding a channel's read position. */
export function cursorKey(channelId: string): string {
  return `lastTs-${channelId}`;
}

/** A Slack message timestamp (`<seconds>.<micros>`), e.g. `1700000000.000100`. */
export const slackTsSchema = z
  .string()
  .regex(/^\d+\.\d+$/, 'expected a Slack ts like 1700000000.000100');

/** A validated Slack message timestamp. */
export type SlackTs = z.infer<typeof slackTsSchema>;

/** Read position per channel ID. */
export type Cursors = Record<string, SlackTs>;

/**
 * The part of a `channels.json` entry this module knows: the channel
 * name and a possible legacy `lastTs`. Other curated fields are never
 * read and are preserved on rewrite. Both are `unknown` because the file
 * is unvalidated JSON; {@link loadPollCursors} validates `lastTs` with
 * {@link slackTsSchema}.
 */
export const channelEntrySchema = z.object({
  name: z.unknown().optional(),
  lastTs: z.unknown().optional(),
});

/** The part of a `channels.json` entry this module reads. */
export type ChannelEntry = z.infer<typeof channelEntrySchema>;

/** Legacy "never polled" values: absent, not migrated. */
const NEVER_POLLED = new Set<unknown>([undefined, '', '0']);

/**
 * Validate a read position found at `where`.
 *
 * @throws If `value` is not a Slack ts.
 */
function parseTs(value: unknown, where: string): SlackTs {
  const parsed = slackTsSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Invalid Slack read position ${JSON.stringify(value)} in ${where}: ${parsed.error.issues.map((i) => i.message).join('; ')}. Aborting poll.`,
    );
  }
  return parsed.data;
}

/**
 * Run a store operation, rethrowing any failure as a clear poll-fatal
 * error.
 */
function withStore<T>(op: () => T): T {
  try {
    return op();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Slack read positions unavailable: runner state store error (${msg}). Aborting poll.`,
      { cause: err },
    );
  }
}

/**
 * Persist one channel's read position to the runner state store.
 *
 * @throws If the store cannot be written.
 */
export function saveCursor(
  client: RunnerClient,
  channelId: string,
  ts: string,
): void {
  withStore(() => {
    client.setState(SLACK_STATE_NAMESPACE, cursorKey(channelId), ts);
  });
}

/**
 * Load read positions for every channel in `channels` from the runner
 * state store. The store is probed first, so an unavailable store fails
 * even when `channels` is empty.
 *
 * Per channel:
 * - stored position: used (must be a Slack ts);
 * - no stored position, legacy `lastTs` in `channels.json`: migrated,
 *   i.e. written to the store immediately (before anything rewrites
 *   `channels.json`) and used;
 * - neither (or legacy `'0'` / `''`, "never polled"): absent from the
 *   result, so the channel is read from the beginning.
 *
 * @throws If the store cannot be read or written, or a stored or legacy
 * position is not a Slack ts.
 */
export function loadPollCursors(
  client: RunnerClient,
  channels: Record<string, ChannelEntry>,
): { cursors: Cursors; migrated: number } {
  const read = (id: string): string | null =>
    withStore(() => client.getState(SLACK_STATE_NAMESPACE, cursorKey(id)));

  // Probe (key `lastTs-`, never a channel): fail on an unavailable store
  // even with no channels to read.
  read('');

  const cursors: Cursors = {};
  let migrated = 0;
  for (const [id, info] of Object.entries(channels)) {
    const stored = read(id);
    if (stored !== null) {
      cursors[id] = parseTs(stored, `runner state ${cursorKey(id)}`);
      continue;
    }
    const legacy = info.lastTs;
    if (NEVER_POLLED.has(legacy)) continue;
    const ts = parseTs(legacy, `channels.json ${id}.lastTs`);
    saveCursor(client, id, ts);
    cursors[id] = ts;
    migrated++;
  }
  return { cursors, migrated };
}

/**
 * Write `channels.json` with every `lastTs` stripped: the single writer
 * of the file. The caller's map is not mutated. Channel and field order
 * are kept, and output matches the committed, prettier-formatted file
 * (2-space indent, exactly one trailing newline), so rewriting an
 * unchanged map is byte-identical and leaves no spurious diff.
 *
 * @throws If the file cannot be written.
 */
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
  fs.writeFileSync(
    channelsFile,
    `${JSON.stringify(stripped, null, 2)}\n`,
    'utf8',
  );
}

/**
 * Prepare a poll run's state: run channel discovery, then load read
 * positions for the complete channel set (so a rediscovered channel
 * resumes from its stored position), then rewrite `channels.json` (no
 * `lastTs`) if discovery added channels. Positions load (and legacy
 * values migrate) before any rewrite of `channels.json`.
 *
 * @param discover - Adds new channels to `channels` in place; resolves
 * to the number added.
 * @throws As {@link loadPollCursors}; `channels.json` is then untouched.
 */
export async function preparePollState<T extends ChannelEntry>(
  client: RunnerClient,
  channelsFile: string,
  channels: Record<string, T>,
  discover: () => Promise<number>,
): Promise<{ cursors: Cursors; migrated: number; discovered: number }> {
  const discovered = await discover();
  const { cursors, migrated } = loadPollCursors(client, channels);
  if (discovered > 0) saveChannels(channelsFile, channels);
  return { cursors, migrated, discovered };
}
