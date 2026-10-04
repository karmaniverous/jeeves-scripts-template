#!/usr/bin/env tsx
/**
 * @module calendar/poll
 *
 * Polls Google Calendar events for all configured accounts.
 *
 * Called by jeeves-runner on a schedule. Iterates accounts returned by
 * getCalendarAccounts(), fetches events via the Calendar API, and writes
 * individual JSON files to the silo-routed data archive with SHA-256
 * hash-based change detection. Requires CREDENTIALS_DIR, GOG_CLIENT_PATH,
 * and GOG_CONFIG_DIR from constants for Google auth setup. Service-account
 * accounts (`calendar.serviceAccount: "auto"`) use the key gog registered
 * at `<GOG_CONFIG_DIR>/data/sa-<base64(email)>.json` (or, for older gog
 * builds without `data/`, in the `<GOG_CONFIG_DIR>` root); token-file
 * accounts need the gog OAuth client.
 *
 * No calendar accounts: skips (exit 0). Each account's own credential is
 * checked first (lib/calendar-accounts.ts); accounts missing it are
 * reported, the rest are polled, and then the run fails (exit 1).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { AccountConfig as JeevesAccountConfig } from '@karmaniverous/jeeves';
import { createGoogleAuth, ensureDir, runScript } from '@karmaniverous/jeeves';
import type { RunnerClient } from '@karmaniverous/jeeves-runner';
import { getRunnerClient } from '@karmaniverous/jeeves-runner';

import {
  CREDENTIALS_DIR,
  GOG_CLIENT_PATH,
  GOG_CONFIG_DIR,
} from '../lib/constants.js';
import {
  detectGogCredentials,
  findServiceAccountFile,
} from '../lib/gog-credentials.js';
import { getCalendarAccounts } from '../lib/pipeline-config.js';
import { getBasePathForEmailDomain } from '../lib/silo-router.js';
import { resolveCalendarAccounts } from './lib/calendar-accounts.js';
import {
  type CalendarEvent,
  getAllEvents,
  listCalendars,
} from './lib/calendar-api.js';

const googleAuth = createGoogleAuth({
  clientCredentialsPath: GOG_CLIENT_PATH,
  credentialsDir: CREDENTIALS_DIR,
  serviceAccountDir: GOG_CONFIG_DIR,
});

// ========== Config ==========

const INITIAL_LOOKBACK_DAYS = 90;
const FORWARD_DAYS = 90;
const STATE_NAMESPACE = 'calendar';
const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

// ========== Helpers ==========

function sanitize(s: string): string {
  return (s || 'unknown')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 100);
}

function getCalendarBase(email: string): string {
  const domain = email.split('@')[1];
  const basePath = getBasePathForEmailDomain(domain);
  return path.join(basePath, 'calendar', email);
}

function eventHash(event: CalendarEvent): string {
  const significant = {
    summary: event.summary,
    description: event.description,
    start: event.start,
    end: event.end,
    location: event.location,
    status: event.status,
    attendees: (event.attendees ?? []).map((a) => ({
      email: a.email,
      responseStatus: a.responseStatus,
    })),
    recurrence: event.recurrence,
    updated: event.updated,
  };
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(significant))
    .digest('hex')
    .substring(0, 16);
}

function writeEvent(
  calBase: string,
  calendarId: string,
  calendarSummary: string | undefined,
  event: CalendarEvent,
): boolean {
  const calDir = path.join(calBase, sanitize(calendarSummary ?? calendarId));
  ensureDir(calDir);

  const eventId = event.id;
  const eventPath = path.join(calDir, `${eventId}.json`);

  const stored = {
    _calendarId: calendarId,
    _calendarSummary: calendarSummary,
    _ingestedAt: new Date().toISOString(),
    _hash: eventHash(event),
    ...event,
  };

  if (fs.existsSync(eventPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(eventPath, 'utf8')) as {
        _hash?: string;
      };
      if (existing._hash === stored._hash) return false;
    } catch {
      // Corrupted file, overwrite
    }
  }

  fs.writeFileSync(eventPath, JSON.stringify(stored, null, 2) + '\n', 'utf8');
  return true;
}

// ========== Account Polling ==========

async function pollAccount(
  account: JeevesAccountConfig,
  client: RunnerClient,
): Promise<void> {
  const { email } = account;
  console.log(`\n=== ${email} ===`);

  const accessToken = await googleAuth.getAccessToken(account, CALENDAR_SCOPES);

  const now = new Date();
  const lastSync = client.getState(STATE_NAMESPACE, `lastSync-${email}`);
  const timeMin = lastSync
    ? new Date(new Date(lastSync).getTime() - 24 * 60 * 60 * 1000).toISOString()
    : new Date(
        now.getTime() - INITIAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
  const timeMax = new Date(
    now.getTime() + FORWARD_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  console.log(
    `  Time window: ${timeMin.substring(0, 10)} → ${timeMax.substring(0, 10)}`,
  );

  const calendars = await listCalendars(accessToken);
  console.log(`  Found ${String(calendars.length)} calendars`);

  const calBase = getCalendarBase(email);
  let totalEvents = 0;
  let updatedEvents = 0;

  for (const cal of calendars) {
    if (cal.accessRole === 'freeBusyReader') continue;

    try {
      const events = await getAllEvents(accessToken, cal.id, timeMin, timeMax);
      if (events.length === 0) continue;

      for (const event of events) {
        totalEvents++;
        if (writeEvent(calBase, cal.id, cal.summary, event)) {
          updatedEvents++;
        }
      }

      console.log(
        `  ${sanitize(cal.summary ?? cal.id)}: ${String(events.length)} events`,
      );
    } catch (e) {
      console.error(
        `  Error fetching ${cal.summary ?? cal.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  console.log(
    `  Total: ${String(totalEvents)} events, ${String(updatedEvents)} new/updated`,
  );

  client.setState(STATE_NAMESPACE, `lastSync-${email}`, now.toISOString());
}

// ========== Main ==========

async function main(): Promise<void> {
  const configured = getCalendarAccounts();
  if (configured.length === 0) {
    console.log('[skip] No calendar accounts configured');
    return;
  }

  // Each account must have its own credential: an unrelated key or
  // client does not count.
  const { accounts, problems } = resolveCalendarAccounts(configured, {
    oauthClient: detectGogCredentials().oauthClient,
    oauthClientPath: GOG_CLIENT_PATH,
    findServiceAccount: (email) => findServiceAccountFile(email),
  });
  for (const p of problems) console.error(`[credentials] ${p}`);

  console.log('Calendar poll started:', new Date().toISOString());

  const client = getRunnerClient();

  try {
    for (const account of accounts) {
      try {
        await pollAccount(account, client);
      } catch (e) {
        console.error(
          `Error polling ${account.email}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  } finally {
    client.close();
  }

  console.log('\nCalendar poll complete.');
  if (problems.length > 0) {
    throw new Error(
      `calendar/poll: ${String(problems.length)} calendar account(s) have no usable gog credentials: ${problems.join('; ')}`,
    );
  }
}

runScript('calendar/poll', () => {
  main().catch((err: unknown) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
});
