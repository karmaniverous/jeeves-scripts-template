/**
 * Centralized constants — paths, config values, and magic strings
 * used across multiple scripts.
 *
 * Add your deployment-specific constants here, organized by domain.
 */

// ========== Database ==========

/**
 * Path to the jeeves-runner SQLite database.
 * Override at runtime via the JR_DB_PATH environment variable.
 */
export const DEFAULT_DB_PATH = '/path/to/runner.sqlite';

// ========== Credentials ==========

// export const CREDENTIALS_DIR = '/path/to/credentials';

// ========== Add your own sections below ==========
// Organize by domain: GitHub, Email, Slack, etc.
// Example:
//
// // ========== GitHub ==========
// export const GH_BIN = '/usr/bin/gh';
// export const GH_ACCOUNT = 'your-org';
