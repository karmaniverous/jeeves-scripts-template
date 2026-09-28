/**
 * @module constants/trackers
 *
 * Issue-tracker and entity-pipeline constants — Jira, Linear, and the
 * entity types processed by the meta scripts.
 *
 * Part of the constants barrel (`src/lib/constants.ts`); import from
 * the barrel, not from this module directly.
 */

import path from 'node:path';

import { CONTENT_DIR, CREDENTIALS_DIR } from './instance.js';

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
