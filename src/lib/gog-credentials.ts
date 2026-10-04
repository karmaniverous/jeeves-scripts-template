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
 * Older gog builds (e.g. v0.9.x) have no `data/` folder and register
 * service-account mailboxes in the config root,
 * `<GOG_CONFIG_DIR>/sa-<base64(email)>.json`. Both locations are
 * searched, `data/` first.
 *
 * An instance may use either or both. Service-account-only instances
 * have no OAuth client file, so checking `GOG_CLIENT_PATH` alone is
 * wrong.
 *
 * Called by email/poll.ts, email/google-workspace/download.ts,
 * email/google-workspace/backfill-historical.ts,
 * email/google-workspace/label-actions.ts (drain-updates) and
 * calendar/poll.ts (per-account checks in calendar/lib/
 * calendar-accounts.ts).
 *
 * Config dependencies: GOG_CLIENT_PATH, GOG_CONFIG_DIR from constants.ts.
 */

import fs from 'node:fs';
import path from 'node:path';

import { GOG_CLIENT_PATH, GOG_CONFIG_DIR } from './constants.js';

/** Directory where current gog registers service-account mailboxes. */
export function gogServiceAccountDir(configDir = GOG_CONFIG_DIR): string {
  return path.join(configDir, 'data');
}

/**
 * Directories searched for service-account mailboxes, in order:
 * `<configDir>/data` (current gog), then `<configDir>` (gog v0.9.x).
 */
export function gogServiceAccountDirs(configDir = GOG_CONFIG_DIR): string[] {
  return [gogServiceAccountDir(configDir), configDir];
}

/** File name gog uses for a service-account mailbox registration. */
export function serviceAccountFileName(email: string): string {
  const encoded = Buffer.from(email).toString('base64').replace(/=/g, '');
  return `sa-${encoded}.json`;
}

/** Full path where current gog registers `email` as a service-account mailbox. */
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
 * gog has none. Searches {@link gogServiceAccountDirs} in order.
 */
export function findServiceAccountFile(
  email: string,
  configDir = GOG_CONFIG_DIR,
): string | null {
  const name = serviceAccountFileName(email);
  for (const d of gogServiceAccountDirs(configDir)) {
    const p = path.join(d, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
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
  const serviceAccount = gogServiceAccountDirs(configDir).some(
    (d) =>
      fs.existsSync(d) &&
      fs.readdirSync(d).some((f) => f.startsWith('sa-') && f.endsWith('.json')),
  );
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
      `${gogServiceAccountDirs().join(' or ')}). Configure gog or remove the accounts from pipeline-config.json.`,
  );
}
