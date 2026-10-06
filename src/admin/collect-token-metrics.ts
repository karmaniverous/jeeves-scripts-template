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
 * write-once and immutable. Orchestration lives in lib/collect-run.ts;
 * the agent-DB collector (node:sqlite) is imported lazily, only when the
 * agent DB exists, so legacy hosts on Node < 22.5 still run.
 *
 * On a DB host with no stored DB cursor, OpenClaw usage is counted from
 * the start of its history only when none was ever counted (no legacy
 * cursor entry, no bucket file holding OpenClaw usage), as on a brand-new
 * instance. Otherwise (a host upgraded to 2026.9) it refuses until
 * regenerate-token-metrics --from <upgrade hour> bootstraps the cursor.
 *
 * Config dependencies: OPENCLAW_AGENT_DB_PATH, SESSIONS_DIR,
 * CLAUDE_CODE_PROJECTS_DIR, TOKEN_METRICS_DIR, TOKEN_METRICS_NAMESPACE,
 * TOKEN_METRICS_CURSOR_KEY, TOKEN_METRICS_DB_CURSOR_KEY,
 * TOKEN_METRICS_CC_CURSOR_KEY, TOKEN_RATES_PATH, TOKEN_RATES_PENDING_PATH,
 * TOKEN_RATES_SEED_PATH,
 * SLACK_DM_NAMES_CACHE_PATH, SLACK_USERS_PATH from constants.ts.
 */

import fs from 'node:fs';

import { runScript } from '@karmaniverous/jeeves';

import {
  OPENCLAW_AGENT_DB_PATH,
  SESSIONS_DIR,
  SLACK_DM_NAMES_CACHE_PATH,
  SLACK_USERS_PATH,
  TOKEN_RATES_PATH,
  TOKEN_RATES_PENDING_PATH,
  TOKEN_RATES_SEED_PATH,
} from '../lib/constants.js';
import { currentHourBoundaryMs, flushBuckets } from './lib/bucket-io.js';
import { scanClaudeCodeSessions } from './lib/claude-code-session-scan.js';
import { runCollect } from './lib/collect-run.js';
import { applyDmNames, gatewayMemberName } from './lib/dm-name-sources.js';
import { hasOpenClawBuckets } from './lib/fresh-openclaw-history.js';
import { loadRateCard } from './lib/rate-card.js';
import { addPendingModels } from './lib/rate-card-pending.js';
import { ensureRateCard } from './lib/rate-card-seed.js';
import { scanAllSessions } from './lib/session-scanner.js';
import { openTokenMetricsState } from './lib/token-metrics-state.js';

/**
 * Record the unknown models as pending (refresh-token-rates adds them from
 * OpenRouter), then trigger the refresh job via the runner HTTP API.
 * Fire-and-forget — the collector doesn't wait for it to complete.
 *
 * @param unknownModels - Model ids missing from the rate card.
 */
function triggerRateCardRefresh(unknownModels: string[]): void {
  try {
    addPendingModels(TOKEN_RATES_PENDING_PATH, unknownModels);
  } catch (err: unknown) {
    console.error(
      '[collect-token-metrics] Could not record pending models:',
      err instanceof Error ? err.message : String(err),
    );
  }
  try {
    const url = 'http://127.0.0.1:1937/jobs/refresh-token-rates/trigger';
    fetch(url, { method: 'POST' }).catch(() => {
      // Ignore errors — the failure notification from this job is enough
    });
  } catch {
    // Best effort
  }
}

async function collect(): Promise<void> {
  const code = await runCollect({
    agentDbPath: OPENCLAW_AGENT_DB_PATH,
    sessionsDir: SESSIONS_DIR,
    useDb: fs.existsSync(OPENCLAW_AGENT_DB_PATH),
    cutoffMs: currentHourBoundaryMs(),
    loadOpenClawCollector: () =>
      import('./lib/openclaw-db/collect-openclaw.js'),
    scanLegacy: scanAllSessions,
    scanClaudeCode: scanClaudeCodeSessions,
    ensureRateCard: () => {
      ensureRateCard(TOKEN_RATES_PATH, TOKEN_RATES_SEED_PATH);
    },
    knownModels: () => loadRateCard().models,
    triggerRateCardRefresh,
    nameDms: async (buckets) => {
      await applyDmNames(buckets, {
        cachePath: SLACK_DM_NAMES_CACHE_PATH,
        usersPath: SLACK_USERS_PATH,
        lookup: (id) => gatewayMemberName(id),
      });
    },
    flush: flushBuckets,
    hasOpenClawBuckets: () => hasOpenClawBuckets(),
    openState: openTokenMetricsState,
  });
  if (code !== 0) process.exitCode = code;
}

runScript('collect-token-metrics', collect);
