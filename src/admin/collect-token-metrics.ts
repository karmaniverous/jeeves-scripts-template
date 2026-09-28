#!/usr/bin/env tsx
/**
 * @module collect-token-metrics
 *
 * Token metrics collector — scans OpenClaw session transcripts
 * and Claude Code session logs, then writes immutable hourly
 * rollup buckets to disk.
 *
 * Data sources:
 * - OpenClaw gateway transcripts (SESSIONS_DIR)
 * - Claude Code project sessions (CLAUDE_CODE_PROJECTS_DIR)
 *
 * Designed as a runner cron job. Only processes data up to the
 * previous closed UTC hour boundary so each bucket file is
 * write-once and immutable.
 *
 * Config dependencies: SESSIONS_DIR, CLAUDE_CODE_PROJECTS_DIR,
 * TOKEN_METRICS_DIR, TOKEN_METRICS_NAMESPACE, TOKEN_METRICS_CURSOR_KEY,
 * TOKEN_METRICS_CC_CURSOR_KEY, TOKEN_RATES_PATH, TOKEN_RATES_SEED_PATH
 * from constants.ts.
 */

import { runScript } from '@karmaniverous/jeeves';
import { getRunnerClient } from '@karmaniverous/jeeves-runner';

import {
  TOKEN_METRICS_CC_CURSOR_KEY,
  TOKEN_METRICS_CURSOR_KEY,
  TOKEN_METRICS_NAMESPACE,
  TOKEN_RATES_PATH,
  TOKEN_RATES_SEED_PATH,
} from '../lib/constants.js';
import { currentHourBoundaryMs, flushBuckets } from './lib/bucket-io.js';
import { loadRateCard } from './lib/rate-card.js';
import { ensureRateCard } from './lib/rate-card-seed.js';
import { scanAllSessions } from './lib/session-scanner.js';
import type { CursorState } from './types/token-metrics.js';

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

    // Scan all sessions (fromMs=0 means no lower bound)
    const {
      buckets,
      seenModels,
      ocProcessed,
      ocSkipped,
      ccProcessed,
      ccSkipped,
    } = scanAllSessions(0, cutoffMs, cursors, ccCursors);

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

    // Save cursor state — both OC and CC
    client.setState(
      TOKEN_METRICS_NAMESPACE,
      TOKEN_METRICS_CURSOR_KEY,
      JSON.stringify(cursors),
    );
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
