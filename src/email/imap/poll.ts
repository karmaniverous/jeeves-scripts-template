/**
 * @module imap/poll
 *
 * IMAP account polling — connects to a single configured IMAP account,
 * fetches new messages since the UID watermark, parses MIME, and writes
 * thread.json plus per-message JSON files in the same format as the gog
 * pipeline. Called by email/poll.ts for accounts with an `imap` block.
 *
 * Input: AccountConfig with imap credentials + RunnerClient for state.
 * A `{ secretRef }` password is read from its file (lib/imap-secrets.ts)
 * at connect time; the password is never logged.
 * Output: per-thread directories written to silo-routed content paths.
 */

import fs from 'node:fs';
import path from 'node:path';

import { ensureDir, nowIso, writeJsonAtomic } from '@karmaniverous/jeeves';
import type { RunnerClient } from '@karmaniverous/jeeves-runner';
import type { MailboxLockObject, MailboxObject } from 'imapflow';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

import { resolveImapPassword } from '../../lib/imap-secrets.js';
import type { AccountConfig } from '../../lib/pipeline-config.js';
import { createOrUpdateCache, getThreadsPath } from '../email-cache.js';
import type { AccountTypeDefinition } from './account-types.js';
import { getAccountType } from './account-types.js';
import { resolveKey } from './key-resolver.js';
import type { NormalizedMessage } from './normalize.js';
import { normalizeMessage } from './normalize.js';

// ── Helpers ───────────────────────────────────────────────────────────

/** Extract a readable message from an unknown error value. */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── State ─────────────────────────────────────────────────────────────

interface FolderWatermark {
  uidValidity: number;
  lastUid: number;
}

interface ImapPollState {
  folders: Record<string, FolderWatermark>;
}

const STATE_NS = 'imap-poll';

function loadState(email: string, client: RunnerClient): ImapPollState {
  const raw = client.getState(STATE_NS, email);
  if (!raw) return { folders: {} };
  return JSON.parse(raw) as ImapPollState;
}

function saveState(
  email: string,
  state: ImapPollState,
  client: RunnerClient,
): void {
  client.setState(STATE_NS, email, JSON.stringify(state));
}

// ── Disk writes ───────────────────────────────────────────────────────

function messageExists(
  account: string,
  threadId: string,
  msgId: string,
): boolean {
  return fs.existsSync(
    path.join(getThreadsPath(account, threadId), `${msgId}.json`),
  );
}

/** Write thread cache + per-message JSON from a NormalizedMessage. */
function writeMessage(
  account: string,
  threadId: string,
  messageId: string,
  msg: NormalizedMessage,
  labels: string[],
): void {
  const dir = getThreadsPath(account, threadId);
  ensureDir(dir);

  createOrUpdateCache({
    account,
    threadId,
    subject: msg.headers.subject,
    participants: [
      ...new Set(
        [msg.headers.from, msg.headers.to, msg.headers.cc].filter(Boolean),
      ),
    ],
    messages: {
      [messageId]: {
        messageId,
        from: msg.headers.from,
        to: msg.headers.to,
        cc: msg.headers.cc,
        date: msg.headers.date || null,
        internalDateMs: msg.internalDate.getTime(),
        labels,
        snippet: msg.computed.snippet,
        hasAttachments: msg.attachments.length > 0,
        attachments: msg.attachments,
      },
    },
    provenance: [],
  });

  writeJsonAtomic(path.join(dir, `${messageId}.json`), {
    messageId,
    threadId,
    account,
    subject: msg.headers.subject,
    from: msg.headers.from,
    to: msg.headers.to,
    cc: msg.headers.cc,
    date: msg.headers.date || null,
    internalDateMs: msg.internalDate.getTime(),
    labels,
    body: msg.body,
    attachments: msg.attachments,
    downloadedAt: nowIso(),
  });
}

// ── Folder poller ─────────────────────────────────────────────────────

interface FolderStats {
  fetched: number;
  written: number;
  skipped: number;
  failed: number;
}

const MAX_INITIAL_FETCH = 100;

async function pollFolder(
  conn: ImapFlow,
  folder: string,
  account: AccountConfig,
  typeDef: AccountTypeDefinition,
  state: ImapPollState,
): Promise<FolderStats> {
  const stats: FolderStats = { fetched: 0, written: 0, skipped: 0, failed: 0 };
  let lock: MailboxLockObject | null = null;

  try {
    lock = await conn.getMailboxLock(folder, { readOnly: true });
    const mailbox = conn.mailbox as MailboxObject;
    const uidValidity = Number(mailbox.uidValidity);
    const wm: FolderWatermark = state.folders[folder] ?? {
      uidValidity,
      lastUid: 0,
    };

    if (wm.uidValidity !== uidValidity) {
      console.log(
        `[imap] uidValidity changed for "${folder}", resetting watermark`,
      );
      wm.uidValidity = uidValidity;
      wm.lastUid = 0;
    }

    // On first run (no watermark), fetch only the tail to avoid
    // loading an entire mailbox into memory.
    const isFirstRun = wm.lastUid === 0;
    let fetchRange: string;
    if (isFirstRun && mailbox.exists > MAX_INITIAL_FETCH) {
      const startSeq = mailbox.exists - MAX_INITIAL_FETCH + 1;
      console.log(
        `[imap] First run for "${folder}", fetching last ${String(MAX_INITIAL_FETCH)} of ${String(mailbox.exists)} messages`,
      );
      fetchRange = `${String(startSeq)}:*`;
    } else {
      fetchRange = `${String(wm.lastUid + 1)}:*`;
    }

    const messages = await conn.fetchAll(
      fetchRange,
      {
        uid: true,
        source: true,
        flags: true,
        internalDate: true,
        threadId: true,
        labels: true,
      },
      isFirstRun ? undefined : { uid: true },
    );

    let maxUid = wm.lastUid;
    for (const fetchMsg of messages) {
      stats.fetched++;
      if (fetchMsg.uid > maxUid) maxUid = fetchMsg.uid;
      try {
        if (!fetchMsg.source) {
          stats.failed++;
          continue;
        }
        const mail = await simpleParser(fetchMsg.source);
        const normalized = normalizeMessage(fetchMsg, mail);
        const threadId = resolveKey(typeDef.threadId, normalized);
        const messageId = resolveKey(typeDef.messageId, normalized);

        if (messageExists(account.email, threadId, messageId)) {
          stats.skipped++;
          continue;
        }

        writeMessage(
          account.email,
          threadId,
          messageId,
          normalized,
          typeDef.labels(normalized),
        );
        stats.written++;
      } catch (e) {
        console.error(
          `[imap] uid=${String(fetchMsg.uid)} failed: ${errMsg(e)}`,
        );
        stats.failed++;
      }
    }
    wm.lastUid = maxUid;
    state.folders[folder] = wm;
  } finally {
    lock?.release();
  }
  return stats;
}

// ── Account poller (public) ───────────────────────────────────────────

export interface ImapAccountStats {
  fetched: number;
  written: number;
  skipped: number;
  failed: number;
  folders: number;
}

/**
 * Poll a single IMAP account. Connects, fetches new messages across all
 * configured folders, writes to disk, and updates watermarks. Returns
 * aggregate stats. Skips gracefully on auth failure.
 */
export async function pollImapAccount(
  account: AccountConfig,
  client: RunnerClient,
): Promise<ImapAccountStats> {
  const totals: ImapAccountStats = {
    fetched: 0,
    written: 0,
    skipped: 0,
    failed: 0,
    folders: 0,
  };
  if (!account.imap) return totals;

  // Throws (naming the ref and path, never the value) when a secretRef
  // file is missing or unreadable; poll.ts logs it and moves on.
  const pass = resolveImapPassword(account.imap.password);
  const conn = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.tls,
    auth: { user: account.imap.user, pass },
    logger: false,
  });

  try {
    await conn.connect();
  } catch (e) {
    if (/auth|login|credential/i.test(errMsg(e))) {
      console.error(`[imap] Auth failed for ${account.email}: ${errMsg(e)}`);
      return totals;
    }
    throw e;
  }

  const typeDef = getAccountType(account.type);

  try {
    const state = loadState(account.email, client);
    const folders = account.folders ?? (await typeDef.folders(conn));

    for (const folder of folders) {
      try {
        const s = await pollFolder(conn, folder, account, typeDef, state);
        totals.fetched += s.fetched;
        totals.written += s.written;
        totals.skipped += s.skipped;
        totals.failed += s.failed;
        totals.folders++;
      } catch (e) {
        console.error(`[imap] Folder "${folder}" error: ${errMsg(e)}`);
      }
    }
    saveState(account.email, state, client);
  } finally {
    await conn.logout();
  }
  return totals;
}
