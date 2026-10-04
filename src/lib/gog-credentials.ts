/**
 * @module gog-credentials
 *
 * Single source of truth for "which Google credentials does gog have?".
 *
 * gog authenticates a mailbox in one of two ways:
 *
 * - **OAuth client**: `<GOG_CONFIG_DIR>/credentials.json`
 *   (`GOG_CLIENT_PATH`) plus a per-account token in the gog keyring.
 * - **Service account (domain-wide delegation)**: gog registers each
 *   delegated mailbox as `<GOG_CONFIG_DIR>/data/sa-<base64(email)>.json`,
 *   with the base64 `=` padding stripped.
 *
 * An instance may use either or both. Service-account-only instances
 * have no OAuth client file, so checking `GOG_CLIENT_PATH` alone is
 * wrong.
 *
 * Called by email/poll.ts, email/google-workspace/download.ts,
 * email/google-workspace/drain-updates.ts and calendar/poll.ts.
 *
 * Config dependencies: GOG_CLIENT_PATH, GOG_CONFIG_DIR from constants.ts.
 */

import fs from 'node:fs';
import path from 'node:path';

import { GOG_CLIENT_PATH, GOG_CONFIG_DIR } from './constants.js';

/** Directory where gog registers service-account mailboxes. */
export function gogServiceAccountDir(configDir = GOG_CONFIG_DIR): string {
  return path.join(configDir, 'data');
}

/** File name gog uses for a service-account mailbox registration. */
export function serviceAccountFileName(email: string): string {
  const encoded = Buffer.from(email).toString('base64').replace(/=/g, '');
  return `sa-${encoded}.json`;
}

/** Full path where gog registers `email` as a service-account mailbox. */
export function serviceAccountKeyPath(
  email: string,
  configDir = GOG_CONFIG_DIR,
): string {
  return path.join(
    gogServiceAccountDir(configDir),
    serviceAccountFileName(email),
  );
}

/**
 * Path of the service-account registration for `email`, or `null` when
 * gog has none.
 */
export function findServiceAccountFile(
  email: string,
  configDir = GOG_CONFIG_DIR,
): string | null {
  const p = serviceAccountKeyPath(email, configDir);
  return fs.existsSync(p) ? p : null;
}

/** Which gog credentials are present. */
export interface GogCredentials {
  /** OAuth client file exists. */
  oauthClient: boolean;
  /** At least one service-account mailbox is registered. */
  serviceAccount: boolean;
  /** Either kind is present. */
  any: boolean;
}

/** Detect the gog credentials available under `configDir`. */
export function detectGogCredentials(
  configDir = GOG_CONFIG_DIR,
): GogCredentials {
  const oauthClient = fs.existsSync(
    configDir === GOG_CONFIG_DIR
      ? GOG_CLIENT_PATH
      : path.join(configDir, path.basename(GOG_CLIENT_PATH)),
  );
  const saDir = gogServiceAccountDir(configDir);
  const serviceAccount =
    fs.existsSync(saDir) &&
    fs
      .readdirSync(saDir)
      .some((f) => f.startsWith('sa-') && f.endsWith('.json'));
  return { oauthClient, serviceAccount, any: oauthClient || serviceAccount };
}

/**
 * Gate a gog-backed job.
 *
 * - No accounts need gog: returns `false` (nothing to do; the caller
 *   skips quietly).
 * - Accounts need gog and credentials exist: returns `true`.
 * - Accounts need gog but there are no credentials at all: throws, so
 *   the runner records a failed run instead of a silent success.
 *
 * @param job - Job name for the error message.
 * @param accountCount - Number of accounts that need gog.
 * @throws When `accountCount > 0` and no gog credentials exist.
 */
export function requireGogCredentials(
  job: string,
  accountCount: number,
  creds: GogCredentials = detectGogCredentials(),
): boolean {
  if (accountCount === 0) return false;
  if (creds.any) return true;
  throw new Error(
    `${job}: ${String(accountCount)} Google account(s) configured but no gog credentials found ` +
      `(no OAuth client at ${GOG_CLIENT_PATH} and no service-account mailboxes in ` +
      `${gogServiceAccountDir()}). Configure gog or remove the accounts from pipeline-config.json.`,
  );
}
