/**
 * Shared runner client factory — single source of truth for database path.
 */

import { createClient, type RunnerClient } from '@karmaniverous/jeeves-runner';

import { DEFAULT_DB_PATH } from './constants.js';

/**
 * Create a runner client using the standard database path.
 * Honors `JR_DB_PATH` env var for test overrides.
 */
export function getRunnerClient(): RunnerClient {
  return createClient(process.env.JR_DB_PATH ?? DEFAULT_DB_PATH);
}

export type { RunnerClient };
