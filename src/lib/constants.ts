/**
 * @module constants
 *
 * Centralized constants — paths, config values, and magic strings
 * used across multiple scripts.
 *
 * THIS IS THE FIRST FILE TO EDIT on a new instance. Update each
 * section with your instance-specific values. Scripts that import
 * from here will pick up the changes automatically.
 *
 * Sections marked [REQUIRED] must be filled in before the associated
 * pipeline domain will work. Sections marked [OPTIONAL] have sensible
 * defaults or are only needed for specific integrations.
 */

import os from 'node:os';
import path from 'node:path';

// ========== Instance Identity [REQUIRED] ==========

/**
 * Human-readable instance name. Used in log messages and status output.
 * Set this to match the instance name from `jeeves-tools create`.
 */
export const INSTANCE_NAME = '';

/**
 * Root content directory. All pipeline output (email, meetings, github,
 * slack, calendar) is written under this path.
 *
 * On jeeves-tools-managed instances this defaults to
 * /opt/jeeves/openclaw/content.
 */
export const CONTENT_DIR = '/opt/jeeves/openclaw/content';

/**
 * Root directory for the scripts repo checkout. Used to resolve
 * spawn-worker and other self-referencing paths.
 */
export const SCRIPTS_DIR = '/opt/jeeves/jeeves-scripts';

// ========== Pipeline Config [REQUIRED] ==========

/**
 * Path to pipeline-config.json — operational configuration for email
 * accounts, domain routing, and feature flags.
 *
 * On jeeves-tools-managed instances, `configure` renders this file.
 * On standalone instances, create it manually (see pipeline-config.ts
 * for the schema).
 */
export const PIPELINE_CONFIG_PATH =
  '/opt/jeeves/jeeves-scripts/pipeline-config.json';

// ========== Silo Routing [OPTIONAL] ==========

/**
 * Path to silo-routing.json — multi-tenant data routing by email
 * domain, GitHub org, and Slack workspace.
 *
 * Single-tenant instances can leave this unconfigured; scripts fall
 * back to CONTENT_DIR when no routing config exists.
 */
export const SILO_ROUTING_CONFIG_PATH = '/opt/jeeves/config/silo-routing.json';

// ========== Credentials [REQUIRED] ==========

/**
 * Root directory for all credential files (OAuth tokens, API keys,
 * service account JSON, etc.).
 *
 * Individual service credential paths are derived from this root.
 */
export const CREDENTIALS_DIR = '/opt/jeeves/config/credentials';

// ========== GitHub [REQUIRED] ==========

/**
 * Path to the GitHub CLI binary. On Linux, use bare 'gh' (resolved
 * via PATH). On Windows, specify the full path.
 */
export const GH_BIN = 'gh';

/**
 * Directory where gh CLI stores its config (auth tokens, hosts.yml).
 * Set via GH_CONFIG_DIR env var before any gh invocations.
 */
export const GH_CONFIG_DIR = '/opt/jeeves/config/gh-cli';

/**
 * Primary GitHub account that owns repos and receives notifications.
 */
export const GH_ACCOUNT = '';

/**
 * GitHub bot user for automated operations (PR creation, issue comments).
 */
export const GH_BOT_USER = '';

/**
 * Directory where GitHub pipeline output is written (repo metadata,
 * issue snapshots, registry). Derived from CONTENT_DIR.
 */
export const GITHUB_DIR = path.join(CONTENT_DIR, 'github');

/**
 * Path to the GitHub registry JSON file — tracks synced repos and
 * their metadata state.
 */
export const GITHUB_REGISTRY_PATH = path.join(GITHUB_DIR, 'registry.json');

// ========== Email [REQUIRED] ==========

/**
 * Directory where email pipeline events (download confirmations,
 * classification results) are persisted for runner state tracking.
 */
export const EMAIL_EVENTS_DIR = '/opt/jeeves/state/runner/email-events';

// ========== Google Auth [REQUIRED] ==========

/**
 * Google Workspace CLI binary name. On Linux this resolves via PATH;
 * on Windows it also resolves via PATH after installer adds it.
 *
 * The gog CLI uses APPDATA to locate its config directory — see gog.ts
 * for the APPDATA override that points to CREDENTIALS_DIR.
 */
export const GOG_BIN = 'gog';

/**
 * Directory where gogcli stores credentials (credentials.json, tokens).
 * Derived from CREDENTIALS_DIR so all Google credentials live on the
 * data volume (survives system rebuilds).
 */
export const GOG_CONFIG_DIR = path.join(CREDENTIALS_DIR, 'gogcli');

/**
 * Path to the Google OAuth client credentials file used by gogcli.
 */
export const GOG_CLIENT_PATH = path.join(GOG_CONFIG_DIR, 'credentials.json');

// ========== Meetings [OPTIONAL] ==========

/**
 * Default directory for meeting extraction output. Meeting extractors
 * (Google Meet, Fathom, Notion) write structured meeting.json files here.
 * Derived from CONTENT_DIR.
 */
export const DEFAULT_MEETINGS_DIR = path.join(CONTENT_DIR, 'meetings');

// ========== Slack [OPTIONAL] ==========

/**
 * Directory where Slack pipeline output is written (archived messages,
 * channel metadata). Derived from CONTENT_DIR.
 */
export const SLACK_DOMAIN_DIR = path.join(CONTENT_DIR, 'slack');

/**
 * Slack workspace team ID for the primary workspace being indexed.
 */
export const PRIMARY_WORKSPACE = '';

/**
 * Path to cached Slack channel-to-workspace mapping. Used by the
 * channel mapper to resolve channel IDs to workspace context.
 */
export const SLACK_WORKSPACE_CACHE_PATH =
  '/opt/jeeves/config/slack-channel-workspaces.json';

// ========== Notion [OPTIONAL] ==========

/**
 * Notion API version string. Update when migrating to a newer API version.
 */
export const NOTION_VERSION = '2025-09-03';

/**
 * Path to the Notion API key file. The key is read from this file
 * at runtime by meeting ingestion and other Notion-dependent scripts.
 */
export const NOTION_API_KEY_PATH = path.join(CREDENTIALS_DIR, 'notion-api-key');

// ========== X / Twitter [OPTIONAL] ==========

/**
 * Directory where jeeves-server stores OAuth2 credentials for the
 * legacy X auth flow. Used by older scripts during migration.
 */
export const X_OAUTH_DIR = path.join(CREDENTIALS_DIR, 'oauth');

/**
 * Per-account X content directories. Keys are account handles, values
 * are the directory where that account's X pipeline output is written.
 */
export const X_ACCOUNTS: Record<string, string> = {};

// ========== Jira [OPTIONAL] ==========

/**
 * Base URL of the Jira Cloud site.
 * e.g. `'https://mysite.atlassian.net'`
 */
export const JIRA_SITE_URL: string = '';

/**
 * Atlassian account email used for Jira API basic auth.
 * e.g. `'jason@example.com'`
 */
export const JIRA_EMAIL: string = '';

/**
 * Path to a file containing the Jira API token (plain text, one line).
 * Generate at https://id.atlassian.com/manage-profile/security/api-tokens
 */
export const JIRA_API_TOKEN_PATH: string = '';

/**
 * Filename for the Jira custom field metadata cache written by
 * refresh-fields.ts. Lives at the root of the Jira domain directory.
 */
export const JIRA_FIELDS_FILENAME = '_fields.json';

/**
 * Maximum number of history entries to retain per entity file.
 * Older entries are dropped when the cap is reached.
 */
export const JIRA_MAX_HISTORY = 50;

/**
 * Root directory for Jira domain output. Used by the refresh-fields
 * and backfill scripts on single-tenant instances; multi-tenant paths
 * are resolved at runtime via `getBasePathForJira()` in silo-router.ts.
 */
export const JIRA_DIR = path.join(CONTENT_DIR, 'jira');

// ========== Linear [OPTIONAL] ==========

/**
 * Path to Linear API config file (JSON with apiKey, apiUrl, webhookSecret).
 * Auth: plain `Authorization: <key>` header (not Bearer).
 */
export const LINEAR_CONFIG_PATH: string =
  process.env.LINEAR_CONFIG_PATH || path.join(CREDENTIALS_DIR, 'linear.json');

/**
 * Maximum number of history entries per Linear entity file.
 */
export const LINEAR_MAX_HISTORY = 50;

/**
 * Root directory for Linear domain output. Multi-tenant paths
 * resolved via `getBasePathForLinear()` in silo-router.ts.
 */
export const LINEAR_DIR = path.join(CONTENT_DIR, 'linear');

// ========== Entity Pipeline [OPTIONAL] ==========

/**
 * Configuration for entity types processed by meta scripts (sweep-duplicates,
 * disable-old-meta). Each entry defines an entity type's content subdirectory,
 * the meta key variants that mark an entity for rejection, and the age
 * threshold for disabling stale meta.
 *
 * Add entries here when introducing new entity types that participate in the
 * meta discovery/synthesis lifecycle (§3). The meta scripts loop over this
 * array and resolve actual root directories via silo-router at runtime.
 */
export interface EntityTypeConfig {
  /** Subdirectory name under each silo base path (e.g. 'meetings'). */
  subdir: string;
  /** Case-insensitive meta key variants that mark an entity for rejection/deletion. */
  rejectionKeys: string[];
  /** Age threshold in days for disable-old-meta (null = never auto-disable). */
  maxAgeDays: number | null;
}

export const ENTITY_TYPES: EntityTypeConfig[] = [
  {
    subdir: 'meetings',
    rejectionKeys: ['nonmeeting', 'non_meeting'],
    maxAgeDays: 7,
  },
  {
    subdir: 'jira/issue',
    rejectionKeys: [],
    maxAgeDays: null,
  },
  {
    subdir: 'linear/issue',
    rejectionKeys: [],
    maxAgeDays: null,
  },
];

// ========== Qdrant [OPTIONAL] ==========

/**
 * Base URL for the Qdrant HTTP API.
 * Override with the QDRANT_API_URL environment variable on non-default installs.
 */
export const QDRANT_API_URL =
  process.env.QDRANT_API_URL ?? 'http://localhost:6333';

/**
 * System service name for Qdrant.
 * Used by qdrant-health-check.ts to restart the service via systemctl / Restart-Service.
 */
export const QDRANT_SERVICE_NAME = 'qdrant';

// ========== Gateway [REQUIRED] ==========

/**
 * Hostname for the OpenClaw gateway HTTP API. Scripts invoke gateway
 * tools (sessions_spawn, sessions_list) at this address.
 */
export const GATEWAY_HOST = '127.0.0.1';

/**
 * Port for the OpenClaw gateway HTTP API.
 */
export const GATEWAY_PORT = 18789;

// ========== Spawn Worker [REQUIRED] ==========

/**
 * Absolute path to the spawn-worker script. Used by runner's
 * dispatchSession() to launch worker sessions. Derived from SCRIPTS_DIR.
 */
export const SPAWN_WORKER_PATH = path.join(
  SCRIPTS_DIR,
  'src/lib/spawn-worker.ts',
);

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
 * Directory where token metric bucket files are written. Each hourly
 * bucket is an immutable JSON file tracking token usage per model.
 */
export const TOKEN_METRICS_DIR =
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
 * Path to the aggregated token rates JSON file. Written by
 * refresh-token-rates, read by dashboards and cost reporting.
 */
export const TOKEN_RATES_PATH = path.join(
  TOKEN_METRICS_DIR,
  'token-rates.json',
);

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
