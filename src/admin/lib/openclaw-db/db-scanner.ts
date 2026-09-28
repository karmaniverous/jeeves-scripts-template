/**
 * @module openclaw-db/db-scanner
 *
 * Turns OpenClaw transcripts (from a schema module or legacy archives) into
 * hourly token buckets. Channels come from session metadata when the store
 * has it, else the legacy text rules over the first 50 events
 * (channel-from-meta.ts); usage parsing is the JSONL collector's, so costs
 * match exactly. Pure over its inputs; no fs/DB writes.
 *
 * Per transcript, events are walked in seq order from the cursor:
 * - seq <= cursor.lastSeq: already handled, skipped;
 * - a usage event at/after `toMs` stops the walk (the cursor stays before
 *   it, so the next run picks it up; nothing in an open hour is lost);
 * - usage before `fromMs` is skipped but handled (cursor advances);
 * - other usage is counted into `[hour, channel, model]`.
 * The starting cursor is the transcript's own, else its seed (see
 * {@link resolvePrior}). Cursors are stamped with the transcript
 * generation; an immutable transcript walked to its end is marked
 * `complete` and later runs skip it without loading it.
 * With `countedOnly`, events past the pre-existing cursor are left alone
 * and the cursor is not advanced (rebuilding already-counted ranges).
 */

import type { HourlyBucket } from '../../types/token-metrics.js';
import { mergeUsage, tsToHour } from '../bucket-io.js';
import { registerChannelName } from '../channel-mapper.js';
import { normalizeUsage, parseUsageLine } from '../usage-parser.js';
import { resolveChannel } from './channel-from-meta.js';
import type { DbCursorState } from './db-cursor.js';
import type { SessionMeta, TranscriptEvent, TranscriptRef } from './types.js';

/** Events used for channel detection (same as the JSONL collector). */
const CHANNEL_HEAD_EVENTS = 50;

type Cursor = DbCursorState[string];

/** Options for one scan. */
export interface DbScanOptions {
  fromMs: number;
  toMs: number;
  /** Rebuild only already-counted events; never advance cursors. */
  countedOnly?: boolean;
}

/** Scan counters. */
export interface DbScanStats {
  transcriptsProcessed: number;
  transcriptsSkipped: number;
  usageCounted: number;
}

function channelFor(
  events: TranscriptEvent[],
  meta: SessionMeta | undefined,
): string {
  const result = resolveChannel(
    meta,
    events.slice(0, CHANNEL_HEAD_EVENTS).map((e) => e.json),
  );
  if (result.key.startsWith('slack:channel:') && result.name.startsWith('#'))
    registerChannelName(result.key, result.name);
  return result.key;
}

/**
 * The cursor a transcript starts from:
 * - its own cursor, unless that cursor is stamped with a generation this
 *   key has since retired (archived) and the transcript is a different
 *   generation: then it restarts from nothing;
 * - else its seed cursor when the seed counted this generation (stamped
 *   with it, or unstamped and `acceptUnstamped`), marked `inherited`;
 * - else none.
 */
export function resolvePrior(
  ref: TranscriptRef,
  cursors: DbCursorState,
): { prior: Cursor | undefined; inherited: boolean } {
  const own = cursors[ref.cursorKey] as Cursor | undefined;
  if (own) {
    const retired =
      own.generation !== undefined &&
      ref.generation !== undefined &&
      own.generation !== ref.generation &&
      ref.retiredGenerations?.has(own.generation) === true;
    return { prior: retired ? undefined : own, inherited: false };
  }
  const seed = ref.seed
    ? (cursors[ref.seed.key] as Cursor | undefined)
    : undefined;
  const matches =
    seed !== undefined &&
    (seed.generation === undefined
      ? ref.seed?.acceptUnstamped === true
      : seed.generation === ref.generation);
  return matches
    ? {
        prior: { lastSeq: seed.lastSeq, lastTimestamp: seed.lastTimestamp },
        inherited: true,
      }
    : { prior: undefined, inherited: false };
}

function sameCursor(a: Cursor | undefined, b: Cursor): boolean {
  return (
    a !== undefined &&
    a.lastSeq === b.lastSeq &&
    a.lastTimestamp === b.lastTimestamp &&
    a.generation === b.generation &&
    a.complete === b.complete
  );
}

/**
 * Scan transcripts into `buckets`, updating `cursors` in place (unless
 * `countedOnly`). Models seen are added to `seenModels`.
 */
export function scanTranscripts(
  transcripts: TranscriptRef[],
  cursors: DbCursorState,
  options: DbScanOptions,
  buckets: Map<string, HourlyBucket>,
  seenModels: Set<string>,
): DbScanStats {
  const stats: DbScanStats = {
    transcriptsProcessed: 0,
    transcriptsSkipped: 0,
    usageCounted: 0,
  };

  for (const ref of transcripts) {
    const { prior, inherited } = resolvePrior(ref, cursors);
    const startSeq = prior?.lastSeq ?? -1;
    const limitSeq = options.countedOnly ? startSeq : Infinity;
    const firstSeq = options.countedOnly ? -1 : startSeq;

    const done =
      prior?.complete === true ||
      (ref.maxSeq !== undefined && ref.maxSeq <= startSeq);
    if (
      (!options.countedOnly && done) ||
      (options.countedOnly && startSeq < 0)
    ) {
      stats.transcriptsSkipped++;
      continue;
    }

    const events = ref.load();
    const channel = channelFor(events, ref.meta);
    let lastSeq = startSeq;
    let lastTimestamp = prior?.lastTimestamp ?? 0;
    let reachedEnd = true;

    for (const event of events) {
      if (event.seq <= firstSeq) continue;
      if (event.seq > limitSeq) break;

      const parsed = parseUsageLine(event.json);
      if (parsed) {
        if (parsed.tsMs >= options.toMs) {
          reachedEnd = false;
          break;
        }
        if (parsed.tsMs >= options.fromMs) {
          const modelKey = [parsed.provider, parsed.model].join('/');
          seenModels.add(modelKey);
          mergeUsage(
            buckets,
            tsToHour(parsed.tsMs),
            channel,
            modelKey,
            normalizeUsage(parsed.rawUsage, modelKey),
          );
          stats.usageCounted++;
          if (parsed.tsMs > lastTimestamp) lastTimestamp = parsed.tsMs;
        }
      }
      lastSeq = Math.max(lastSeq, event.seq);
    }

    const next: Cursor = { lastSeq, lastTimestamp };
    if (ref.generation !== undefined) next.generation = ref.generation;
    if (ref.immutable && reachedEnd) next.complete = true;
    const own = cursors[ref.cursorKey] as Cursor | undefined;
    if (
      !options.countedOnly &&
      (lastSeq > startSeq || inherited || next.complete) &&
      !sameCursor(own, next)
    )
      cursors[ref.cursorKey] = next;
    stats.transcriptsProcessed++;
  }

  return stats;
}
