/**
 * @module constants/token-metrics
 *
 * Token-metrics constants — session sources (OpenClaw, Claude Code),
 * bucket/rate-card/cursor paths, DM naming caches, and session refresh.
 *
 * Part of the constants barrel (`src/lib/constants.ts`); import from
 * the barrel, not from this module directly.
 */

import os from 'node:os';
import path from 'node:path';

import { SCRIPTS_DIR } from './instance.js';

// ========== Token Metrics [OPTIONAL] ==========

/**
 * Directory where OpenClaw session transcripts are stored. Scanned
 * by collect-token-metrics for usage accounting.
 */
export const SESSIONS_DIR = path.join(
  os.homedir(),
  '.openclaw/agents/main/sessions',
);

/**
 * OpenClaw 2026.9+ agent SQLite store. When present, collect-token-metrics
 * reads OpenClaw usage from it (read-only, schema-pinned) instead of the
 * legacy SESSIONS_DIR transcript files.
 */
export const OPENCLAW_AGENT_DB_PATH = path.join(
  os.homedir(),
  '.openclaw/agents/main/agent/openclaw-agent.sqlite',
);

/** Environment variable that holds {@link OPENCLAW_UPGRADE_CUTOFF}. */
export const OPENCLAW_UPGRADE_CUTOFF_ENV = 'OPENCLAW_UPGRADE_CUTOFF';

/**
 * First UTC hour of OpenClaw 2026.9 usage on this instance (the hour it
 * switched to the agent SQLite store), ISO 8601. Hours before it were
 * counted by the legacy JSONL collector and must not be rewritten.
 *
 * Per instance, read from the OPENCLAW_UPGRADE_CUTOFF environment
 * variable, with NO default: undefined when unset or empty. Only live
 * regenerate-token-metrics runs use it; they refuse to run without it and
 * refuse an earlier --from unless --allow-pre-upgrade is given. The
 * hourly collector, scratch (--out) regenerations and reports never read
 * it.
 */
export const OPENCLAW_UPGRADE_CUTOFF: string | undefined =
  process.env[OPENCLAW_UPGRADE_CUTOFF_ENV] || undefined;

/**
 * Directory where token metric bucket files are written. Each hourly
 * bucket is an immutable JSON file tracking token usage per model.
 * Override with the TOKEN_METRICS_DIR environment variable (e.g. to point
 * a scratch regeneration at a copied rate card).
 */
export const TOKEN_METRICS_DIR =
  process.env.TOKEN_METRICS_DIR ??
  '/opt/jeeves/state/jeeves-runner/token-metrics';

/**
 * Runner state namespace for token metrics cursor tracking.
 */
export const TOKEN_METRICS_NAMESPACE = 'token-metrics';

/**
 * Runner state key for the token metrics scan cursor.
 */
export const TOKEN_METRICS_CURSOR_KEY = 'cursors';

/**
 * Runner state key for the OpenClaw agent-DB cursor
 * (per-transcript last processed sequence number).
 */
export const TOKEN_METRICS_DB_CURSOR_KEY = 'cursors-openclaw-db';

/**
 * Path to the token rate card ($/MTok per model). Verified and updated
 * by refresh-token-rates, read by the collector and cost reporting.
 */
export const TOKEN_RATES_PATH = path.join(
  TOKEN_METRICS_DIR,
  'token-rates.json',
);

/**
 * Cache of Slack DM counterpart names (user id → name) learned by the
 * token-metrics collectors, so a `slack:dm:<USERID>` channel is looked up
 * once and then named `slack:dm:<person>`.
 */
export const SLACK_DM_NAMES_CACHE_PATH = path.join(
  TOKEN_METRICS_DIR,
  'slack-dm-names.json',
);

/**
 * Cached Slack user map written by the Slack poller (user id → user).
 * Read-only for token metrics (DM naming).
 */
export const SLACK_USERS_PATH = path.join(
  SCRIPTS_DIR,
  'src/slack/lib/users.json',
);

/**
 * Seed rate card shipped with the scripts repo. Copied to
 * TOKEN_RATES_PATH only when no rate card exists (never overwrites).
 */
export const TOKEN_RATES_SEED_PATH = path.join(
  SCRIPTS_DIR,
  'config/token-rates.seed.json',
);

// ========== Claude Code [OPTIONAL] ==========

/**
 * Directory where Claude Code stores per-project configuration.
 * Scanned by token-metrics for Claude Code session accounting.
 */
export const CLAUDE_CODE_PROJECTS_DIR = path.join(
  os.homedir(),
  '.claude/projects',
);

/**
 * Runner state key for the Claude Code token metrics scan cursor.
 * Separate from the main cursor because CC transcripts live in a
 * different directory tree.
 */
export const TOKEN_METRICS_CC_CURSOR_KEY = 'cursors-claude-code';

// ========== Session Refresh [OPTIONAL] ==========

/**
 * Cache read token threshold — sessions exceeding this count are
 * candidates for refresh to manage context window costs.
 */
export const SESSION_REFRESH_CACHE_READ_THRESHOLD = 150_000;

/**
 * Idle minutes before a session is considered stale and eligible
 * for automatic refresh.
 */
export const SESSION_REFRESH_IDLE_MINUTES = 60;
