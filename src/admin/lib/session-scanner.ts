/**
 * @module session-scanner
 *
 * Shared session file scanning logic for the token metrics pipeline.
 *
 * Scans OpenClaw gateway transcripts and Claude Code session logs,
 * extracting usage records within a [fromMs, cutoffMs) time range,
 * and merging them into hourly buckets.
 *
 * Shared by collect-token-metrics and recalculate-token-metrics.
 */

import fs from 'node:fs';
import path from 'node:path';

import { SESSIONS_DIR } from '../../lib/constants.js';
import type { CursorState, HourlyBucket } from '../types/token-metrics.js';
import { mergeUsage, tsToHour } from './bucket-io.js';
import { detectChannel, registerChannelName } from './channel-mapper.js';
import { scanClaudeCodeSessions } from './claude-code-session-scan.js';
import { normalizeUsage, parseUsageLine } from './usage-parser.js';

/** Result returned by scanAllSessions. */
export interface ScanResult {
  buckets: Map<string, HourlyBucket>;
  seenModels: Set<string>;
  ocProcessed: number;
  ocSkipped: number;
  ccProcessed: number;
  ccSkipped: number;
}

/**
 * Process a single OpenClaw session file: extract usage records
 * within [fromMs, cutoffMs), detect channel, and merge into buckets.
 */
function processOCFile(
  filePath: string,
  fileName: string,
  cursors: CursorState,
  fromMs: number,
  cutoffMs: number,
  buckets: Map<string, HourlyBucket>,
  seenModels: Set<string>,
): void {
  const stat = fs.statSync(filePath);
  const cursor = cursors[fileName] as CursorState[string] | undefined;
  const byteOffset = cursor?.byteOffset ?? 0;

  // Skip if fully processed and file hasn't grown
  if (byteOffset >= stat.size) return;

  const content = fs.readFileSync(filePath, 'utf8');
  const allLines = content.split('\n');

  // Detect channel from the first few lines (always, even if resuming)
  // Use first 50 lines for channel detection. 15 was too narrow — long-lived
  // topic thread sessions often have metadata/custom lines filling the first 15,
  // pushing recognizable patterns (heartbeat, Slack context) just out of reach.
  const channelResult = detectChannel(allLines.slice(0, 50));
  if (channelResult.key.startsWith('slack:channel:')) {
    const name = channelResult.name;
    if (name.startsWith('#')) {
      registerChannelName(channelResult.key, name);
    }
  }

  // Compute byte positions per line to know where to resume
  let bytePos = 0;
  let maxProcessedTs = cursor?.lastTimestamp ?? 0;

  for (const line of allLines) {
    const lineByteLen = Buffer.byteLength(line, 'utf8') + 1; // +1 for \n
    const lineStart = bytePos;
    bytePos += lineByteLen;

    // Skip lines we've already processed
    if (lineStart < byteOffset) continue;
    if (!line.trim()) continue;

    const parsed = parseUsageLine(line);
    if (!parsed) continue;

    // Only include records within range
    if (parsed.tsMs < fromMs) continue;
    // Skip messages in the current (incomplete) hour
    if (parsed.tsMs >= cutoffMs) continue;

    const modelKey = [parsed.provider, parsed.model].join('/');
    seenModels.add(modelKey);
    const usage = normalizeUsage(parsed.rawUsage, modelKey);
    const hour = tsToHour(parsed.tsMs);

    mergeUsage(buckets, hour, channelResult.key, modelKey, usage);

    if (parsed.tsMs > maxProcessedTs) {
      maxProcessedTs = parsed.tsMs;
    }
  }

  // Update cursor: advance byteOffset to current file size
  cursors[fileName] = {
    byteOffset: stat.size,
    lastTimestamp: maxProcessedTs,
  };
}

/**
 * List OpenClaw transcript files in SESSIONS_DIR.
 *
 * OpenClaw 2026.9+ keeps transcripts in its agent SQLite store, so the
 * legacy directory may be missing or empty. In that case log clearly and
 * return no files: OpenClaw sources are skipped and Claude Code collection
 * continues.
 */
function listOCSessionFiles(): string[] {
  if (!fs.existsSync(SESSIONS_DIR)) {
    console.warn(
      `[token-metrics] SESSIONS_DIR not found (${SESSIONS_DIR}); skipping OpenClaw transcripts, Claude Code collection continues.`,
    );
    return [];
  }

  const sessionFiles = fs
    .readdirSync(SESSIONS_DIR)
    .filter(
      (f) =>
        f.endsWith('.jsonl') ||
        f.includes('.jsonl.deleted.') ||
        f.includes('.jsonl.reset.'),
    );

  if (sessionFiles.length === 0) {
    console.warn(
      `[token-metrics] SESSIONS_DIR has no transcript files (${SESSIONS_DIR}); skipping OpenClaw transcripts, Claude Code collection continues.`,
    );
  }

  return sessionFiles;
}

/**
 * Scan all OpenClaw and Claude Code session files, extracting usage
 * records within [fromMs, cutoffMs) and merging into hourly buckets.
 *
 * For the regular collector, pass fromMs=0 (no lower bound).
 * For recalculation, pass the user's fromMs.
 */
export function scanAllSessions(
  fromMs: number,
  cutoffMs: number,
  cursors: CursorState,
  ccCursors: CursorState,
): ScanResult {
  const buckets = new Map<string, HourlyBucket>();
  const seenModels = new Set<string>();

  // ── OpenClaw sessions ──
  const sessionFiles = listOCSessionFiles();

  let ocProcessed = 0;
  let ocSkipped = 0;

  for (const fileName of sessionFiles) {
    const filePath = path.join(SESSIONS_DIR, fileName);
    const cursor = cursors[fileName] as CursorState[string] | undefined;
    const stat = fs.statSync(filePath);

    if (cursor?.byteOffset !== undefined && cursor.byteOffset >= stat.size) {
      ocSkipped++;
      continue;
    }

    processOCFile(
      filePath,
      fileName,
      cursors,
      fromMs,
      cutoffMs,
      buckets,
      seenModels,
    );
    ocProcessed++;
  }

  // ── Claude Code sessions ──
  const { ccProcessed, ccSkipped } = scanClaudeCodeSessions(
    fromMs,
    cutoffMs,
    ccCursors,
    buckets,
    seenModels,
  );

  return {
    buckets,
    seenModels,
    ocProcessed,
    ocSkipped,
    ccProcessed,
    ccSkipped,
  };
}
