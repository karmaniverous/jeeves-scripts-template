/**
 * @module regen-run
 *
 * Orchestration for regenerate-token-metrics (the entry point wires real
 * adapters; tests inject fakes). Rebuilds hourly buckets for [from, to)
 * from the OpenClaw agent DB plus Claude Code logs:
 * - scratch (`out`): fresh scan into an empty directory; never touches
 *   runner state or the live store.
 * - live, unbounded: scan from seq 0 / reset CC cursors, back up then delete
 *   the range's buckets, flush, and REPLACE the DB and CC cursors.
 * - live, bounded (`to`): rebuild from already-counted events only
 *   (OpenClaw seq <= stored cursor, CC bytes before the stored offset);
 *   cursors are left exactly as stored.
 * `dryRun` scans and reports without writing buckets, backups, the
 * DM-name cache or runner state. A backup failure throws before any
 * bucket is deleted.
 *
 * Live runs (dry or not) need the instance's upgrade cutoff and refuse a
 * pre-cutoff `from` unless `allowPreUpgrade` (regen-guard.ts). Scratch runs
 * cannot rewrite history, so they neither need the cutoff nor check it.
 */

import {
  TOKEN_METRICS_CC_CURSOR_KEY,
  TOKEN_METRICS_DB_CURSOR_KEY,
} from '../../lib/constants.js';
import type { CursorState, HourlyBucket } from '../types/token-metrics.js';
import type { CCScanOptions } from './claude-code-session-scan.js';
import type { DbCursorState } from './openclaw-db/db-cursor.js';
import { parseDbCursorState } from './openclaw-db/db-cursor.js';
import type { DbScanOptions } from './openclaw-db/db-scanner.js';
import { enumHours, resetCursorsForRange } from './recalc-utils.js';
import { checkRegenFrom } from './regen-guard.js';
import type { TokenMetricsState } from './token-metrics-state.js';

const TAG = '[regen]';
const HOUR_MS = 3_600_000;

/** Parsed command-line arguments. */
export interface RegenArgs {
  from: string;
  to: string;
  out: string;
  dryRun: boolean;
  allowPreUpgrade: boolean;
}

/** Adapters used by {@link runRegen}. */
export interface RegenDeps {
  agentDbPath: string;
  agentDbExists: boolean;
  cutoffMs: number;
  /** OPENCLAW_UPGRADE_CUTOFF (ISO 8601), undefined when unset. */
  upgradeCutoff: string | undefined;
  scanOpenClaw: (
    cursors: DbCursorState,
    options: DbScanOptions,
    buckets: Map<string, HourlyBucket>,
    seenModels: Set<string>,
  ) => Promise<{
    schemaVersion: number;
    transcriptsProcessed: number;
    usageCounted: number;
  }>;
  scanClaudeCode: (
    fromMs: number,
    toMs: number,
    cursors: CursorState,
    buckets: Map<string, HourlyBucket>,
    seenModels: Set<string>,
    options: CCScanOptions,
  ) => { ccProcessed: number };
  knownModels: () => Record<string, unknown>;
  bucketExists: (hour: string, dir: string) => boolean;
  backup: (hours: string[], dryRun: boolean) => number;
  remove: (hours: string[], dryRun: boolean) => number;
  flush: (buckets: Map<string, HourlyBucket>, dir?: string) => number;
  nameDms: (
    buckets: Map<string, HourlyBucket>,
    dryRun: boolean,
  ) => Promise<void>;
  openState: () => TokenMetricsState;
}

/** Parse an ISO argument and floor it to the UTC hour. */
function hourArg(value: string): number {
  const ms = new Date(value).getTime();
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

function fail(message: string): number {
  console.error(`${TAG} ${message}`);
  return 1;
}

interface ScanPlan {
  fromMs: number;
  toMs: number;
  dbCursors: DbCursorState;
  ccCursors: CursorState;
  countedOnly: boolean;
}

/** Scan both sources; returns an error message when models are unknown. */
async function scanRange(
  plan: ScanPlan,
  buckets: Map<string, HourlyBucket>,
  deps: RegenDeps,
): Promise<string | null> {
  const seenModels = new Set<string>();
  const { fromMs, toMs, countedOnly } = plan;
  const oc = await deps.scanOpenClaw(
    plan.dbCursors,
    { fromMs, toMs, countedOnly },
    buckets,
    seenModels,
  );
  const cc = deps.scanClaudeCode(
    fromMs,
    toMs,
    plan.ccCursors,
    buckets,
    seenModels,
    { countedOnly },
  );
  console.log(
    `${TAG} OpenClaw DB schema ${String(oc.schemaVersion)}: ${String(oc.transcriptsProcessed)} transcripts, ${String(oc.usageCounted)} usage events; Claude Code: ${String(cc.ccProcessed)} files`,
  );
  const known = deps.knownModels();
  const unknown = [...seenModels].filter((m) => !(m in known));
  return unknown.length > 0
    ? `Unknown models — refusing to write buckets: ${unknown.join(', ')}`
    : null;
}

async function runLive(
  range: { fromMs: number; toMs: number; hours: string[] },
  args: RegenArgs,
  deps: RegenDeps,
): Promise<number> {
  const bounded = Boolean(args.to);
  const state = deps.openState();
  try {
    const stored = parseDbCursorState(state.get(TOKEN_METRICS_DB_CURSOR_KEY));
    if (bounded && !stored)
      return fail(
        'No OpenClaw DB cursor yet; bootstrap by running without --to first.',
      );
    const rawCC = state.get(TOKEN_METRICS_CC_CURSOR_KEY);
    const storedCC = rawCC ? (JSON.parse(rawCC) as CursorState) : {};
    const plan: ScanPlan = {
      ...range,
      countedOnly: bounded,
      dbCursors: bounded && stored ? stored : {},
      ccCursors: bounded
        ? storedCC
        : resetCursorsForRange(storedCC, range.fromMs),
    };
    const buckets = new Map<string, HourlyBucket>();
    const refused = await scanRange(plan, buckets, deps);
    if (refused) return fail(refused);
    await deps.nameDms(buckets, args.dryRun);

    const backed = deps.backup(range.hours, args.dryRun);
    const deleted = deps.remove(range.hours, args.dryRun);
    console.log(
      `${TAG} ${String(backed)} buckets backed up, ${String(deleted)} deleted`,
    );
    if (args.dryRun) {
      console.log(
        `${TAG} Dry run complete — would write ${String(buckets.size)} buckets; no changes made.`,
      );
      return 0;
    }

    const written = deps.flush(buckets);
    if (!bounded) {
      state.set(TOKEN_METRICS_DB_CURSOR_KEY, JSON.stringify(plan.dbCursors));
      state.set(TOKEN_METRICS_CC_CURSOR_KEY, JSON.stringify(plan.ccCursors));
    }
    console.log(
      `${TAG} Done: ${String(written)} buckets written${bounded ? '; cursors unchanged' : ', OpenClaw DB and Claude Code cursors replaced'}`,
    );
    return 0;
  } finally {
    state.close();
  }
}

async function runScratch(
  range: { fromMs: number; toMs: number; hours: string[] },
  args: RegenArgs,
  deps: RegenDeps,
): Promise<number> {
  const existing = range.hours.filter((h) => deps.bucketExists(h, args.out));
  if (existing.length > 0)
    return fail(
      `${args.out} already has ${String(existing.length)} buckets in range; use an empty directory.`,
    );
  const buckets = new Map<string, HourlyBucket>();
  const plan = { ...range, dbCursors: {}, ccCursors: {}, countedOnly: false };
  const refused = await scanRange(plan, buckets, deps);
  if (refused) return fail(refused);
  await deps.nameDms(buckets, args.dryRun);
  if (args.dryRun) {
    console.log(`${TAG} Would write ${String(buckets.size)} buckets.`);
    return 0;
  }
  console.log(
    `${TAG} Wrote ${String(deps.flush(buckets, args.out))} buckets to ${args.out}.`,
  );
  return 0;
}

/**
 * Run a regeneration.
 *
 * @returns process exit code (0 = success)
 */
export async function runRegen(
  args: RegenArgs,
  deps: RegenDeps,
): Promise<number> {
  if (!args.from) return fail('--from ISO is required.');
  if (!deps.agentDbExists)
    return fail(
      `No OpenClaw agent DB at ${deps.agentDbPath}; use recalculate-token-metrics.ts.`,
    );

  const fromMs = hourArg(args.from);
  const toMs = args.to
    ? Math.min(hourArg(args.to), deps.cutoffMs)
    : deps.cutoffMs;
  if (isNaN(fromMs) || isNaN(toMs) || fromMs >= toMs)
    return fail('Invalid or empty range.');
  if (!args.out) {
    const refused = checkRegenFrom(
      fromMs,
      deps.upgradeCutoff,
      args.allowPreUpgrade,
    );
    if (refused) return fail(refused);
  }

  const hours = enumHours(fromMs, toMs - 1);
  console.log(
    `${TAG} ${args.dryRun ? 'DRY RUN — ' : ''}${args.out ? `scratch → ${args.out}` : 'LIVE store'}: ${new Date(fromMs).toISOString()} → ${new Date(toMs).toISOString()} (${String(hours.length)} hours)`,
  );
  const range = { fromMs, toMs, hours };
  return args.out ? runScratch(range, args, deps) : runLive(range, args, deps);
}
