/**
 * @module collect-run
 *
 * Orchestration for collect-token-metrics (the entry point wires real
 * adapters; tests inject fakes). One hourly run:
 * 1. seed the rate card (the usage parser prices through it);
 * 2. scan OpenClaw usage up to the last closed hour: from the agent DB on
 *    2026.9+ hosts, else the legacy SESSIONS_DIR transcripts; then Claude
 *    Code logs;
 * 3. refuse to write when a model is missing from the rate card (triggers
 *    a rate refresh);
 * 4. name id-only Slack DMs, flush buckets, THEN save cursors.
 * The agent-DB collector (and with it node:sqlite, absent before Node
 * 22.5) is loaded only on the DB branch, so legacy hosts on older Node
 * runtimes never import it.
 */

import {
  TOKEN_METRICS_CC_CURSOR_KEY,
  TOKEN_METRICS_CURSOR_KEY,
  TOKEN_METRICS_DB_CURSOR_KEY,
} from '../../lib/constants.js';
import type { CursorState, HourlyBucket } from '../types/token-metrics.js';
import type { CollectOpenClawParams } from './openclaw-db/collect-openclaw.js';
import type { DbCursorState } from './openclaw-db/db-cursor.js';
import type { ScanResult } from './session-scanner.js';
import type { TokenMetricsState } from './token-metrics-state.js';

const TAG = '[token-metrics]';

/** The lazily loaded agent-DB collector module. */
export interface OpenClawCollectorModule {
  collectOpenClawDb: (params: CollectOpenClawParams) => DbCursorState | null;
}

/** Adapters used by {@link runCollect}. */
export interface CollectDeps {
  agentDbPath: string;
  sessionsDir: string;
  /** True when the agent DB exists (2026.9+ host). */
  useDb: boolean;
  cutoffMs: number;
  loadOpenClawCollector: () => Promise<OpenClawCollectorModule>;
  scanLegacy: (
    fromMs: number,
    cutoffMs: number,
    cursors: CursorState,
    ccCursors: CursorState,
  ) => ScanResult;
  scanClaudeCode: (
    fromMs: number,
    cutoffMs: number,
    ccCursors: CursorState,
    buckets: Map<string, HourlyBucket>,
    seenModels: Set<string>,
  ) => { ccProcessed: number; ccSkipped: number };
  ensureRateCard: () => void;
  knownModels: () => Record<string, unknown>;
  triggerRateCardRefresh: () => void;
  nameDms: (buckets: Map<string, HourlyBucket>) => Promise<void>;
  flush: (buckets: Map<string, HourlyBucket>) => number;
  openState: () => TokenMetricsState;
}

function parseCursors(raw: string | null): CursorState {
  return raw ? (JSON.parse(raw) as CursorState) : {};
}

/**
 * Run one collection.
 *
 * @returns process exit code (0 = success; the DB collector may also set
 * `process.exitCode` when it refuses to run without a cursor)
 */
export async function runCollect(deps: CollectDeps): Promise<number> {
  const state = deps.openState();
  try {
    deps.ensureRateCard();
    const cursors = parseCursors(state.get(TOKEN_METRICS_CURSOR_KEY));
    const ccCursors = parseCursors(state.get(TOKEN_METRICS_CC_CURSOR_KEY));
    const cutoffMs = deps.cutoffMs;
    console.log(
      `${TAG} Processing files, cutoff: ${new Date(cutoffMs).toISOString()}`,
    );

    let buckets = new Map<string, HourlyBucket>();
    let seenModels = new Set<string>();
    let ocProcessed = 0;
    let ocSkipped = 0;
    let ccProcessed: number;
    let ccSkipped: number;
    let dbCursors: DbCursorState | null = null;

    if (deps.useDb) {
      const { collectOpenClawDb } = await deps.loadOpenClawCollector();
      dbCursors = collectOpenClawDb({
        dbPath: deps.agentDbPath,
        sessionsDir: deps.sessionsDir,
        rawCursor: state.get(TOKEN_METRICS_DB_CURSOR_KEY),
        cutoffMs,
        buckets,
        seenModels,
      });
      ({ ccProcessed, ccSkipped } = deps.scanClaudeCode(
        0,
        cutoffMs,
        ccCursors,
        buckets,
        seenModels,
      ));
    } else {
      ({ buckets, seenModels, ocProcessed, ocSkipped, ccProcessed, ccSkipped } =
        deps.scanLegacy(0, cutoffMs, cursors, ccCursors));
    }
    console.log(
      `${TAG} Claude Code: ${String(ccProcessed)} files processed, ${String(ccSkipped)} skipped`,
    );

    const known = deps.knownModels();
    const unknownModels = [...seenModels].filter((m) => !(m in known));
    if (unknownModels.length > 0) {
      console.error(
        `${TAG} Unknown models — refusing to write buckets:`,
        unknownModels.join(', '),
      );
      console.log(`${TAG} Triggering rate card refresh job...`);
      deps.triggerRateCardRefresh();
      return 1;
    }

    await deps.nameDms(buckets);
    const written = deps.flush(buckets);

    if (dbCursors)
      state.set(TOKEN_METRICS_DB_CURSOR_KEY, JSON.stringify(dbCursors));
    if (!deps.useDb)
      state.set(TOKEN_METRICS_CURSOR_KEY, JSON.stringify(cursors));
    state.set(TOKEN_METRICS_CC_CURSOR_KEY, JSON.stringify(ccCursors));

    console.log(
      `${TAG} Done: ${String(ocProcessed)} OC files processed, ${String(ocSkipped)} skipped, ${String(ccProcessed)} CC files, ${String(written)} buckets written`,
    );
    return 0;
  } finally {
    state.close();
  }
}
