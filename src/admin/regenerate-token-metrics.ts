#!/usr/bin/env tsx
/**
 * @module regenerate-token-metrics
 *
 * Rebuild hourly token buckets for [--from, --to) from the OpenClaw 2026.9+
 * agent DB (read-only) plus Claude Code logs. Also bootstraps the DB cursor
 * that collect-token-metrics needs after the 2026.9 upgrade (a fresh
 * instance with no counted OpenClaw usage needs no bootstrap: the
 * collector starts its cursor empty).
 *
 * Modes (orchestration in lib/regen-run.ts):
 * - `--out DIR` (scratch): fresh scan of the range into DIR. Never reads or
 *   writes runner state or the live bucket store. Refuses if DIR is the
 *   live store (TOKEN_METRICS_DIR, directly or through a symlink) or
 *   already holds buckets in the range (merge-into would double count).
 * - live, no `--to`: rebuild [from, last closed hour). Backs up and deletes
 *   the range's buckets, rescans every transcript from seq 0 (counting only
 *   usage at/after --from) and REPLACES the DB and Claude Code cursors. Use
 *   this to switch a host to the DB reader: `--from <upgrade hour>`.
 * - live with `--to`: rebuild [from, to) from events the incremental
 *   collector has already counted (OpenClaw seq <= stored cursor, Claude
 *   Code bytes before the stored offset); all cursors untouched.
 * `--dry-run` scans and reports without writing anything.
 * Live runs (including `--dry-run`) need the OPENCLAW_UPGRADE_CUTOFF
 * environment variable (this instance's OpenClaw 2026.9 upgrade hour; no
 * default) and refuse when it is unset or invalid. A live `--from` earlier
 * than it is refused (pre-upgrade history is never rewritten) unless
 * `--allow-pre-upgrade` is given. Scratch (`--out`) runs never touch the
 * live store, so they ignore the cutoff and need no flag.
 * Slack DMs recorded only by user id are named via the DM-name cache, the
 * Slack user map, then the gateway (lib/dm-name-sources.ts).
 * node:sqlite is loaded lazily (only when the agent DB is scanned).
 *
 * Usage:
 *   tsx src/admin/regenerate-token-metrics.ts --from ISO [--to ISO] [--out DIR] [--dry-run] [--allow-pre-upgrade]
 */

import fs from 'node:fs';

import { getArg, runScript } from '@karmaniverous/jeeves';

import {
  OPENCLAW_AGENT_DB_PATH,
  OPENCLAW_UPGRADE_CUTOFF,
  SESSIONS_DIR,
  SLACK_DM_NAMES_CACHE_PATH,
  SLACK_USERS_PATH,
  TOKEN_METRICS_DIR,
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
import { scanClaudeCodeSessions } from './lib/claude-code-session-scan.js';
import { applyDmNames, gatewayMemberName } from './lib/dm-name-sources.js';
import { loadRateCard } from './lib/rate-card.js';
import { type RegenDeps, runRegen } from './lib/regen-run.js';
import { isSamePath } from './lib/same-path.js';
import { openTokenMetricsState } from './lib/token-metrics-state.js';

const TAG = '[regen]';

const deps: RegenDeps = {
  agentDbPath: OPENCLAW_AGENT_DB_PATH,
  agentDbExists: fs.existsSync(OPENCLAW_AGENT_DB_PATH),
  cutoffMs: currentHourBoundaryMs(),
  upgradeCutoff: OPENCLAW_UPGRADE_CUTOFF,
  scanOpenClaw: async (cursors, options, buckets, seenModels) => {
    const { scanOpenClawDb } =
      await import('./lib/openclaw-db/scan-openclaw-db.js');
    return scanOpenClawDb({
      dbPath: OPENCLAW_AGENT_DB_PATH,
      sessionsDir: SESSIONS_DIR,
      cursors,
      options,
      buckets,
      seenModels,
    });
  },
  scanClaudeCode: scanClaudeCodeSessions,
  knownModels: () => loadRateCard().models,
  bucketExists: (hour, dir) => fs.existsSync(bucketPath(hour, dir)),
  isLiveStore: (dir) => isSamePath(dir, TOKEN_METRICS_DIR),
  backup: (hours, dryRun) => backupBucketFiles(hours, dryRun, TAG),
  remove: (hours, dryRun) => deleteBucketFiles(hours, dryRun, TAG),
  flush: flushBuckets,
  nameDms: async (buckets, dryRun) => {
    await applyDmNames(buckets, {
      cachePath: SLACK_DM_NAMES_CACHE_PATH,
      usersPath: SLACK_USERS_PATH,
      lookup: (id) => gatewayMemberName(id),
      dryRun,
      tag: TAG,
    });
  },
  openState: openTokenMetricsState,
};

async function regenerate(): Promise<void> {
  const argv = process.argv;
  process.exitCode = await runRegen(
    {
      from: getArg(argv, '--from', ''),
      to: getArg(argv, '--to', ''),
      out: getArg(argv, '--out', ''),
      dryRun: argv.includes('--dry-run'),
      allowPreUpgrade: argv.includes('--allow-pre-upgrade'),
    },
    deps,
  );
}

runScript('regenerate-token-metrics', regenerate);
