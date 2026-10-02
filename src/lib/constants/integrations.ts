/**
 * @module constants/integrations
 *
 * Integration constants — GitHub, email, Google auth, meetings, Slack,
 * Notion, and X / Twitter.
 *
 * Part of the constants barrel (`src/lib/constants.ts`); import from
 * the barrel, not from this module directly.
 */

import path from 'node:path';

import {
  CONFIG_DIR,
  CONTENT_DIR,
  CREDENTIALS_DIR,
  JEEVES_BASE_DIR,
} from './instance.js';

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
export const GH_CONFIG_DIR = `${CONFIG_DIR}/gh-cli`;

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
export const EMAIL_EVENTS_DIR = `${JEEVES_BASE_DIR}/state/runner/email-events`;

// ========== Google Auth [REQUIRED] ==========

/**
 * Google Workspace CLI binary name. On Linux this resolves via PATH;
 * on Windows it also resolves via PATH after installer adds it.
 *
 * The gog CLI locates its home via the GOG_HOME env var — see gog.ts,
 * which defaults GOG_HOME to GOG_CONFIG_DIR.
 */
export const GOG_BIN = 'gog';

/**
 * gog home directory (GOG_HOME): service-account keys, OAuth client
 * credentials, and the file keyring.
 *
 * jeeves-tools deploy provisions `/opt/jeeves/config/gogcli` and sets
 * GOG_HOME to it for the gateway and the runner, so this honours GOG_HOME
 * when set and otherwise derives the same path from CONFIG_DIR.
 */
export const GOG_CONFIG_DIR = process.env.GOG_HOME ?? `${CONFIG_DIR}/gogcli`;

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
export const SLACK_WORKSPACE_CACHE_PATH = `${CONFIG_DIR}/slack-channel-workspaces.json`;

/**
 * Slack poller read positions (`{ "<channelId>": "<lastTs>" }`). Instance
 * state, not config (karmaniverous/jeeves-tools#184): if absent, the poller
 * reads each channel from the beginning. Lives beside the other runner
 * cursors under `state/runner/`.
 */
export const SLACK_CURSORS_PATH = `${JEEVES_BASE_DIR}/state/runner/cursors/slack-last-ts.json`;

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
