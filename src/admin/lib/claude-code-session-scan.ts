/**
 * @module claude-code-session-scan
 *
 * Claude Code session-log scanning for the token metrics pipeline: extracts
 * usage records within [fromMs, cutoffMs) into hourly buckets and advances
 * the per-file byte-offset cursors in place.
 *
 * `countedOnly` rebuilds a bounded range (regenerate-token-metrics --to)
 * from records the collector has ALREADY passed (bytes before each file's
 * stored cursor) and never touches the cursors: a bounded rebuild must not
 * advance a cursor past records it didn't count, or the next collection
 * would skip them.
 */

import fs from 'node:fs';

import type { CursorState, HourlyBucket } from '../types/token-metrics.js';
import { mergeUsage, tsToHour } from './bucket-io.js';
import { listCCSessionFiles, parseCCLine } from './claude-code-scanner.js';
import { normalizeUsage } from './usage-parser.js';

/** Options for a Claude Code scan. */
export interface CCScanOptions {
  /** Count only bytes before the stored cursor; never advance cursors. */
  countedOnly?: boolean;
}

/**
 * Scan Claude Code session files, extracting usage records within
 * [fromMs, cutoffMs) into `buckets` and (unless `countedOnly`) advancing
 * `ccCursors` in place.
 */
export function scanClaudeCodeSessions(
  fromMs: number,
  cutoffMs: number,
  ccCursors: CursorState,
  buckets: Map<string, HourlyBucket>,
  seenModels: Set<string>,
  options: CCScanOptions = {},
): { ccProcessed: number; ccSkipped: number } {
  const ccFiles = listCCSessionFiles();
  let ccProcessed = 0;
  let ccSkipped = 0;

  for (const ccFile of ccFiles) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(ccFile.filePath);
    } catch {
      continue;
    }

    const cursor = ccCursors[ccFile.cursorKey] as
      CursorState[string] | undefined;
    const stored = cursor?.byteOffset ?? 0;
    const skip = options.countedOnly ? stored <= 0 : stored >= stat.size;
    if (skip) {
      ccSkipped++;
      continue;
    }

    const startOffset = options.countedOnly ? 0 : stored;
    const endOffset = options.countedOnly ? stored : Infinity;
    const allLines = fs.readFileSync(ccFile.filePath, 'utf8').split('\n');

    let bytePos = 0;
    let maxProcessedTs = cursor?.lastTimestamp ?? 0;
    // Where the next run resumes: the first record in the open hour, or else
    // the end of the last complete line. An unterminated tail counts as
    // complete only once it parses (a half-written line is re-read later).
    let resumeAt: number | null = null;
    let completeEnd = startOffset;

    for (const [i, line] of allLines.entries()) {
      const lineStart = bytePos;
      bytePos += Buffer.byteLength(line, 'utf8') + 1;

      if (lineStart < startOffset) continue;
      if (lineStart >= endOffset) break;
      // The last element after split is the unterminated tail (or empty).
      const isTail = i === allLines.length - 1;
      if (!isTail) completeEnd = bytePos;
      if (!line.trim()) continue;

      const record = parseCCLine(line);
      if (!record) continue;

      if (record.tsMs < fromMs) continue;
      if (record.tsMs >= cutoffMs) {
        // Recounting already-counted bytes: just skip. Otherwise stop here;
        // this record and everything after it are counted once the hour closes.
        if (options.countedOnly) continue;
        resumeAt = lineStart;
        break;
      }
      if (isTail) completeEnd = bytePos;

      seenModels.add(record.modelKey);
      const usage = normalizeUsage(
        {
          input: record.usage.input,
          output: record.usage.output,
          cacheRead: record.usage.cacheRead,
          cacheWrite: record.usage.cacheWrite,
        },
        record.modelKey,
      );
      mergeUsage(
        buckets,
        tsToHour(record.tsMs),
        ccFile.channelKey,
        record.modelKey,
        usage,
      );

      if (record.tsMs > maxProcessedTs) maxProcessedTs = record.tsMs;
    }

    if (!options.countedOnly)
      ccCursors[ccFile.cursorKey] = {
        byteOffset: resumeAt ?? completeEnd,
        lastTimestamp: maxProcessedTs,
      };
    ccProcessed++;
  }

  return { ccProcessed, ccSkipped };
}
