/**
 * @module calendar-accounts
 *
 * Resolve each configured calendar account to the auth config
 * createGoogleAuth() needs, checking that its own credential exists:
 *
 * - `calendar.tokenFile` accounts need the gog OAuth client
 *   (`GOG_CLIENT_PATH`);
 * - `calendar.serviceAccount: "auto"` accounts need a gog
 *   service-account registration for that mailbox
 *   (`sa-<base64(email)>.json`, see lib/gog-credentials.ts).
 *
 * An unrelated credential (e.g. another mailbox's service-account key)
 * does not satisfy an account. Accounts without their credential are
 * reported as problems; calendar/poll.ts polls the rest and then fails
 * the run.
 *
 * Called by calendar/poll.ts.
 */

import type { AccountConfig as JeevesAccountConfig } from '@karmaniverous/jeeves';

import type { AccountConfig } from '../../lib/pipeline-config.js';

/** Credential lookups (injectable for tests). */
export interface CalendarCredentialDeps {
  /** Whether the gog OAuth client file exists. */
  oauthClient: boolean;
  /** OAuth client path, for messages. */
  oauthClientPath: string;
  /** Service-account registration path for `email`, or null. */
  findServiceAccount: (email: string) => string | null;
}

/** Result of {@link resolveCalendarAccounts}. */
export interface CalendarAccountResolution {
  /** Accounts whose credential exists, ready for createGoogleAuth(). */
  accounts: JeevesAccountConfig[];
  /** One message per account whose credential is missing. */
  problems: string[];
}

/** Resolve calendar accounts, separating those missing their credential. */
export function resolveCalendarAccounts(
  configured: AccountConfig[],
  deps: CalendarCredentialDeps,
): CalendarAccountResolution {
  const accounts: JeevesAccountConfig[] = [];
  const problems: string[] = [];
  for (const { email, calendar } of configured) {
    if (calendar && 'tokenFile' in calendar) {
      if (deps.oauthClient) {
        accounts.push({ email, tokenFile: calendar.tokenFile });
      } else {
        problems.push(
          `${email}: calendar.tokenFile needs the gog OAuth client at ${deps.oauthClientPath}`,
        );
      }
      continue;
    }
    if (calendar && 'serviceAccount' in calendar) {
      const serviceAccount = deps.findServiceAccount(email);
      if (serviceAccount) {
        accounts.push({ email, serviceAccount });
      } else {
        problems.push(
          `${email}: calendar.serviceAccount is "auto" but gog has no service-account registration for this mailbox`,
        );
      }
      continue;
    }
    problems.push(`${email}: no calendar config`);
  }
  return { accounts, problems };
}
