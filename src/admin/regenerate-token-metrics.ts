#!/usr/bin/env tsx
/**
 * @module regenerate-token-metrics
 *
 * Rebuild hourly token buckets for [--from, --to) from the OpenClaw 2026.9+
 * agent DB (read-only) plus Claude Code logs. Also bootstraps the DB cursor
 * that collect-token-metrics needs after the 2026.9 upgrade.
 *
 * Modes:
 * - `--out DIR` (scratch): fresh scan of the range into DIR. Never reads or
 *   writes runner state or the live bucket store. Refuses if DIR already
 *   holds buckets in the range (merge-into would double count).
 * - live, no `--to`: rebuild [from, last closed hour). Backs up and deletes
 *   the range's buckets, rescans every transcript from seq 0 (counting only
 *   usage at/after --from) and REPLACES the DB cursor. Use this to switch a
 *   host to the DB reader: `--from <upgrade hour>`.
 * - live with `--to`: rebuild [from, to) from events the incremental
 *   collector has already counted (seq <= stored cursor); cursor untouched.
 * `--dry-run` scans and reports without writing anything.
 *
 * Usage:
 *   tsx src/admin/regenerate-token-metrics.ts --from ISO [--to ISO] [--out DIR] [--dry-run]
 */

import fs from 'node:fs';

import { getArg, runScript } from '@karmaniverous/jeeves';
import { getRunnerClient } from '@karmaniverous/jeeves-runner';

import {
  OPENCLAW_AGENT_DB_PATH,
  SESSIONS_DIR,
  TOKEN_METRICS_CC_CURSOR_KEY,
  TOKEN_METRICS_DB_CURSOR_KEY,
  TOKEN_METRICS_NAMESPACE,
} from '../lib/constants.js';
import {
  bucketPath,
  currentHourBoundaryMs,
  flushBuckets,
} from './lib/bucket-io.js';
import {
  backupBucketFiles,
  deleteBucketFiles,
} from './lib/bucket-maintenance.js';
import type { DbCursorState } from './lib/openclaw-db/db-cursor.js';
import { parseDbCursorState } from './lib/openclaw-db/db-cursor.js';
import { scanOpenClawDb } from './lib/openclaw-db/scan-openclaw-db.js';
import { loadRateCard } from './lib/rate-card.js';
import { enumHours, resetCursorsForRange } from './lib/recalc-utils.js';
import { scanClaudeCodeSessions } from './lib/session-scanner.js';
import type { CursorState, HourlyBucket } from './types/token-metrics.js';

const TAG = '[regen]';
const HOUR_MS = 3_600_000;

/** Parse an ISO argument and floor it to the UTC hour. */
function hourArg(value: string): number {
  const ms = new Date(value).getTime();
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/** Fail with a message and a non-zero exit code. */
function fail(message: string): void {
  console.error(`${TAG} ${message}`);
  process.exitCode = 1;
}

/** Scan both sources for the range; returns false if models are unknown. */
function scanRange(
  fromMs: number,
  toMs: number,
  dbCursors: DbCursorState,
  countedOnly: boolean,
  ccCursors: CursorState,
  buckets: Map<string, HourlyBucket>,
): boolean {
  const seenModels = new Set<string>();
  const oc = scanOpenClawDb({
    dbPath: OPENCLAW_AGENT_DB_PATH,
    sessionsDir: SESSIONS_DIR,
    cursors: dbCursors,
    options: { fromMs, toMs, countedOnly },
    buckets,
    seenModels,
  });
  const cc = scanClaudeCodeSessions(
    fromMs,
    toMs,
    ccCursors,
    buckets,
    seenModels,
  );
  console.log(
    `${TAG} OpenClaw DB schema ${String(oc.schemaVersion)}: ${String(oc.transcriptsProcessed)} transcripts, ${String(oc.usageCounted)} usage events; Claude Code: ${String(cc.ccProcessed)} files`,
  );

  const rateCard = loadRateCard();
  const unknown = [...seenModels].filter((m) => !(m in rateCard.models));
  if (unknown.length > 0) {
    fail(`Unknown models — refusing to write buckets: ${unknown.join(', ')}`);
    return false;
  }
  return true;
}

function regenerate(): void {
  const dryRun = process.argv.includes('--dry-run');
  const fromArg = getArg(process.argv, '--from', '');
  const toArg = getArg(process.argv, '--to', '');
  const outDir = getArg(process.argv, '--out', '');

  if (!fromArg) {
    fail('--from ISO is required.');
    return;
  }
  if (!fs.existsSync(OPENCLAW_AGENT_DB_PATH)) {
    fail(
      `No OpenClaw agent DB at ${OPENCLAW_AGENT_DB_PATH}; use recalculate-token-metrics.ts.`,
    );
    return;
  }

  const cutoffMs = currentHourBoundaryMs();
  const fromMs = hourArg(fromArg);
  const toMs = toArg ? Math.min(hourArg(toArg), cutoffMs) : cutoffMs;
  if (isNaN(fromMs) || isNaN(toMs) || fromMs >= toMs) {
    fail('Invalid or empty range.');
    return;
  }

  const hours = enumHours(fromMs, toMs - 1);
  console.log(
    `${TAG} ${dryRun ? 'DRY RUN — ' : ''}${outDir ? `scratch → ${outDir}` : 'LIVE store'}: ${new Date(fromMs).toISOString()} → ${new Date(toMs).toISOString()} (${String(hours.length)} hours)`,
  );
  const buckets = new Map<string, HourlyBucket>();

  if (outDir) {
    const existing = hours.filter((h) => fs.existsSync(bucketPath(h, outDir)));
    if (existing.length > 0) {
      fail(
        `${outDir} already has ${String(existing.length)} buckets in range; use an empty directory.`,
      );
      return;
    }
    if (!scanRange(fromMs, toMs, {}, false, {}, buckets)) return;
    if (dryRun) {
      console.log(`${TAG} Would write ${String(buckets.size)} buckets.`);
      return;
    }
    console.log(
      `${TAG} Wrote ${String(flushBuckets(buckets, outDir))} buckets to ${outDir}.`,
    );
    return;
  }

  const client = getRunnerClient();
  try {
    const stored = parseDbCursorState(
      client.getState(TOKEN_METRICS_NAMESPACE, TOKEN_METRICS_DB_CURSOR_KEY),
    );
    if (toArg && !stored) {
      fail(
        'No OpenClaw DB cursor yet; bootstrap by running without --to first.',
      );
      return;
    }
    const dbCursors: DbCursorState = toArg && stored ? stored : {};

    const rawCC = client.getState(
      TOKEN_METRICS_NAMESPACE,
      TOKEN_METRICS_CC_CURSOR_KEY,
    );
    const ccCursors = resetCursorsForRange(
      rawCC ? (JSON.parse(rawCC) as CursorState) : {},
      fromMs,
    );

    if (!scanRange(fromMs, toMs, dbCursors, Boolean(toArg), ccCursors, buckets))
      return;

    const backed = backupBucketFiles(hours, dryRun, TAG);
    const deleted = deleteBucketFiles(hours, dryRun, TAG);
    console.log(
      `${TAG} ${String(backed)} buckets backed up, ${String(deleted)} deleted`,
    );
    if (dryRun) {
      console.log(
        `${TAG} Dry run complete — would write ${String(buckets.size)} buckets; no changes made.`,
      );
      return;
    }

    const written = flushBuckets(buckets);
    if (!toArg)
      client.setState(
        TOKEN_METRICS_NAMESPACE,
        TOKEN_METRICS_DB_CURSOR_KEY,
        JSON.stringify(dbCursors),
      );
    client.setState(
      TOKEN_METRICS_NAMESPACE,
      TOKEN_METRICS_CC_CURSOR_KEY,
      JSON.stringify(ccCursors),
    );
    console.log(
      `${TAG} Done: ${String(written)} buckets written${toArg ? '' : ', OpenClaw DB cursor replaced'}`,
    );
  } finally {
    client.close();
  }
}

runScript('regenerate-token-metrics', regenerate);
