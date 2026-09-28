#!/usr/bin/env tsx
/**
 * @module collect-token-metrics
 *
 * Token metrics collector — scans OpenClaw usage and Claude Code
 * session logs, then writes immutable hourly rollup buckets to disk.
 *
 * Data sources:
 * - OpenClaw 2026.9+ agent SQLite store (OPENCLAW_AGENT_DB_PATH, read-only,
 *   schema-pinned; exits non-zero on an unknown schema) when it exists,
 *   otherwise legacy gateway transcripts (SESSIONS_DIR)
 * - Claude Code project sessions (CLAUDE_CODE_PROJECTS_DIR)
 *
 * Designed as a runner cron job. Only processes data up to the
 * previous closed UTC hour boundary so each bucket file is
 * write-once and immutable.
 *
 * Config dependencies: OPENCLAW_AGENT_DB_PATH, SESSIONS_DIR,
 * CLAUDE_CODE_PROJECTS_DIR, TOKEN_METRICS_DIR, TOKEN_METRICS_NAMESPACE,
 * TOKEN_METRICS_CURSOR_KEY, TOKEN_METRICS_DB_CURSOR_KEY,
 * TOKEN_METRICS_CC_CURSOR_KEY, TOKEN_RATES_PATH, TOKEN_RATES_SEED_PATH
 * from constants.ts.
 */

import fs from 'node:fs';

import { runScript } from '@karmaniverous/jeeves';
import { getRunnerClient } from '@karmaniverous/jeeves-runner';

import {
  OPENCLAW_AGENT_DB_PATH,
  SESSIONS_DIR,
  TOKEN_METRICS_CC_CURSOR_KEY,
  TOKEN_METRICS_CURSOR_KEY,
  TOKEN_METRICS_DB_CURSOR_KEY,
  TOKEN_METRICS_NAMESPACE,
  TOKEN_RATES_PATH,
  TOKEN_RATES_SEED_PATH,
} from '../lib/constants.js';
import { currentHourBoundaryMs, flushBuckets } from './lib/bucket-io.js';
import { collectOpenClawDb } from './lib/openclaw-db/collect-openclaw.js';
import type { DbCursorState } from './lib/openclaw-db/db-cursor.js';
import { loadRateCard } from './lib/rate-card.js';
import { ensureRateCard } from './lib/rate-card-seed.js';
import {
  scanAllSessions,
  scanClaudeCodeSessions,
} from './lib/session-scanner.js';
import type { CursorState, HourlyBucket } from './types/token-metrics.js';

/**
 * Trigger the rate card refresh job via the runner HTTP API.
 * Fire-and-forget — the collector doesn't wait for it to complete.
 */
function triggerRateCardRefresh(): void {
  try {
    const url = 'http://127.0.0.1:1937/jobs/refresh-token-rates/trigger';
    // Fire-and-forget POST
    fetch(url, { method: 'POST' }).catch(() => {
      // Ignore errors — the failure notification from this job is enough
    });
  } catch {
    // Best effort
  }
}

/**
 * Main collector entry point.
 */
function collect(): void {
  const client = getRunnerClient();

  try {
    // Seed the rate card on a fresh instance. Must run before the scan:
    // the usage parser prices each message via the rate card.
    ensureRateCard(TOKEN_RATES_PATH, TOKEN_RATES_SEED_PATH);

    // Load cursor state
    const rawCursors = client.getState(
      TOKEN_METRICS_NAMESPACE,
      TOKEN_METRICS_CURSOR_KEY,
    );
    const cursors: CursorState = rawCursors
      ? (JSON.parse(rawCursors) as CursorState)
      : {};

    const rawCCCursors = client.getState(
      TOKEN_METRICS_NAMESPACE,
      TOKEN_METRICS_CC_CURSOR_KEY,
    );
    const ccCursors: CursorState = rawCCCursors
      ? (JSON.parse(rawCCCursors) as CursorState)
      : {};

    // Compute cutoff: start of current UTC hour
    const cutoffMs = currentHourBoundaryMs();
    const cutoffIso = new Date(cutoffMs).toISOString();
    console.log(`[token-metrics] Processing files, cutoff: ${cutoffIso}`);

    // Scan (fromMs=0 means no lower bound). On 2026.9+ hosts OpenClaw usage
    // comes from the agent DB; the legacy transcript files are not rescanned.
    let buckets = new Map<string, HourlyBucket>();
    let seenModels = new Set<string>();
    let ocProcessed = 0;
    let ocSkipped = 0;
    let ccProcessed: number;
    let ccSkipped: number;
    let dbCursors: DbCursorState | null = null;
    const useDb = fs.existsSync(OPENCLAW_AGENT_DB_PATH);

    if (useDb) {
      dbCursors = collectOpenClawDb({
        dbPath: OPENCLAW_AGENT_DB_PATH,
        sessionsDir: SESSIONS_DIR,
        rawCursor: client.getState(
          TOKEN_METRICS_NAMESPACE,
          TOKEN_METRICS_DB_CURSOR_KEY,
        ),
        cutoffMs,
        buckets,
        seenModels,
      });
      ({ ccProcessed, ccSkipped } = scanClaudeCodeSessions(
        0,
        cutoffMs,
        ccCursors,
        buckets,
        seenModels,
      ));
    } else {
      ({ buckets, seenModels, ocProcessed, ocSkipped, ccProcessed, ccSkipped } =
        scanAllSessions(0, cutoffMs, cursors, ccCursors));
    }

    console.log(
      `[token-metrics] Claude Code: ${String(ccProcessed)} files processed, ${String(ccSkipped)} skipped`,
    );

    // Gate: check for unknown models before writing anything
    const rateCard = loadRateCard();
    const unknownModels = [...seenModels].filter(
      (m) => !(m in rateCard.models),
    );

    if (unknownModels.length > 0) {
      console.error(
        '[token-metrics] Unknown models — refusing to write buckets:',
        unknownModels.join(', '),
      );
      console.log('[token-metrics] Triggering rate card refresh job...');
      triggerRateCardRefresh();
      process.exit(1);
    }

    // Flush buckets to disk
    const written = flushBuckets(buckets);

    // Save cursor state — OC (DB or legacy files) and CC
    if (dbCursors) {
      client.setState(
        TOKEN_METRICS_NAMESPACE,
        TOKEN_METRICS_DB_CURSOR_KEY,
        JSON.stringify(dbCursors),
      );
    }
    if (!useDb) {
      client.setState(
        TOKEN_METRICS_NAMESPACE,
        TOKEN_METRICS_CURSOR_KEY,
        JSON.stringify(cursors),
      );
    }
    client.setState(
      TOKEN_METRICS_NAMESPACE,
      TOKEN_METRICS_CC_CURSOR_KEY,
      JSON.stringify(ccCursors),
    );

    console.log(
      [
        '[token-metrics] Done:',
        String(ocProcessed),
        'OC files processed,',
        String(ocSkipped),
        'skipped,',
        String(ccProcessed),
        'CC files,',
        String(written),
        'buckets written',
      ].join(' '),
    );
  } finally {
    client.close();
  }
}

runScript('collect-token-metrics', collect);
