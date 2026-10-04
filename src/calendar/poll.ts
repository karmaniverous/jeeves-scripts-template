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
 * builds without `data/`, in the `<GOG_CONFIG_DIR>` root).
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
  findServiceAccountFile,
  requireGogCredentials,
} from '../lib/gog-credentials.js';
import { getCalendarAccounts } from '../lib/pipeline-config.js';
import { getBasePathForEmailDomain } from '../lib/silo-router.js';
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

function buildAccounts(): JeevesAccountConfig[] {
  return getCalendarAccounts().map((a) => {
    if (a.calendar && 'tokenFile' in a.calendar) {
      return { email: a.email, tokenFile: a.calendar.tokenFile };
    }
    if (a.calendar && 'serviceAccount' in a.calendar) {
      return {
        email: a.email,
        serviceAccount: findServiceAccountFile(a.email) ?? undefined,
      };
    }
    return { email: a.email };
  });
}

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
  // OAuth client or service-account mailboxes both work; neither with
  // calendar accounts configured is a failed run, not a silent skip.
  if (!requireGogCredentials('calendar/poll', getCalendarAccounts().length)) {
    console.log('[skip] No calendar accounts configured');
    return;
  }

  console.log('Calendar poll started:', new Date().toISOString());

  const client = getRunnerClient();

  try {
    const ACCOUNTS = buildAccounts();
    for (const account of ACCOUNTS) {
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
}

runScript('calendar/poll', () => {
  main().catch((err: unknown) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
});
