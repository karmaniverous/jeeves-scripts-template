/**
 * @module constants/instance
 *
 * Instance-wide constants — identity, content/scripts roots, pipeline and
 * silo-routing config, credentials root, gateway, spawn worker, and Qdrant.
 *
 * Part of the constants barrel (`src/lib/constants.ts`); import from
 * the barrel, not from this module directly.
 */

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
