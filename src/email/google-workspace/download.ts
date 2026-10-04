#!/usr/bin/env tsx
/**
 * @module download
 *
 * Dequeue threads from `email-pending` and download full message bodies
 * from Gmail, saving each message as JSON in the thread cache directory.
 *
 * Called on a schedule as an entry-point script. For each queued thread,
 * fetches messages via `gog gmail thread` or `gog gmail get`, extracts
 * headers/body/attachments, and writes per-message JSON files under
 * the account's threads directory. Logs run stats to EMAIL_EVENTS_DIR.
 *
 * Depends on EMAIL_EVENTS_DIR for run logging and silo-router for
 * per-account thread storage paths. Skips when no gog accounts are
 * configured (getGmailAccounts(): polled Gmail accounts plus
 * emailConfig.backfill.accounts); fails when there are some but gog has
 * no OAuth client and no service-account mailboxes.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  appendJsonl,
  ensureDir,
  nowIso,
  readJson,
  runScript,
  sleepMs,
  writeJsonAtomic,
} from '@karmaniverous/jeeves';
import { getRunnerClient } from '@karmaniverous/jeeves-runner';

import { EMAIL_EVENTS_DIR } from '../../lib/constants.js';
import {
  extractAttachments,
  extractTextFromPayload,
  type GmailHeader,
  type GmailPayloadPart,
  headerValue,
} from '../../lib/email.js';
import { gogWithRetry } from '../../lib/gog.js';
import { requireGogCredentials } from '../../lib/gog-credentials.js';
import { getGmailAccounts } from '../../lib/pipeline-config.js';
import { getThreadsPath } from '../email-cache.js';

function messageExists(
  account: string,
  threadId: string,
  messageId: string,
): boolean {
  const threadsDir = getThreadsPath(account, threadId);
  return fs.existsSync(path.join(threadsDir, `${messageId}.json`));
}

function saveMessage(data: Record<string, unknown>): string {
  const { account, threadId, messageId } = data as {
    account: string;
    threadId: string;
    messageId: string;
  };

  const threadsDir = getThreadsPath(account, threadId);
  ensureDir(threadsDir);
  const p = path.join(threadsDir, `${messageId}.json`);
  writeJsonAtomic(p, data);

  return p;
}

function downloadMessage(
  account: string,
  messageId: string,
): Record<string, unknown> | null {
  const raw = gogWithRetry(
    ['gmail', 'get', messageId, '--json', '--account', account],
    { retries: 2, backoffMs: 5000 },
  );
  if (!raw) return null;
  const payload = JSON.parse(raw) as { message?: Record<string, unknown> };
  return payload.message ?? payload;
}

function main(): void {
  if (!requireGogCredentials('email/download', getGmailAccounts().length)) {
    console.log('[skip] No Gmail accounts configured');
    return;
  }

  const client = getRunnerClient();

  try {
    const items = client.dequeue('email-pending', 50);
    let totalMsg = 0,
      dlMsg = 0,
      dlAtt = 0,
      skipMsg = 0,
      failMsg = 0,
      procTh = 0,
      failTh = 0;
    console.log(`Dequeued ${String(items.length)} threads for download`);

    for (const { id: qId, payload } of items) {
      const { account, threadId } = payload as {
        account: string;
        threadId: string;
      };
      try {
        const threadsThreadPath = path.join(
          getThreadsPath(account, threadId),
          'thread.json',
        );
        const cache = readJson<{ messages?: Record<string, unknown> } | null>(
          threadsThreadPath,
          null,
        );
        let threadMessages: Array<Record<string, unknown>>;
        if (!cache?.messages) {
          // Old thread with no messages map — fetch full thread from API
          console.log(`Fetching full thread ${account}/${threadId}`);
          let threadRaw: string | null;
          try {
            threadRaw = gogWithRetry(
              ['gmail', 'thread', threadId, '--json', '--account', account],
              { retries: 2, backoffMs: 5000 },
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(
              `Failed to fetch thread ${account}/${threadId}: ${msg}`,
            );
            client.fail(qId, msg);
            failTh++;
            continue;
          }
          if (!threadRaw) {
            console.error(
              `Null response fetching thread ${account}/${threadId}`,
            );
            client.fail(qId, 'gog thread returned null');
            failTh++;
            continue;
          }
          const threadData = JSON.parse(threadRaw) as {
            thread?: { messages?: Array<Record<string, unknown>> };
          };
          const msgs = threadData.thread?.messages;
          if (!msgs || msgs.length === 0) {
            console.error(
              `No messages in thread response for ${account}/${threadId}`,
            );
            client.fail(qId, 'thread response had no messages');
            failTh++;
            continue;
          }
          threadMessages = msgs;
          // After processing we'll update thread.json with the messages map
          sleepMs(200);
        } else {
          threadMessages = []; // will use messageId loop below
        }

        let thDl = 0,
          thFail = 0;

        if (threadMessages.length > 0) {
          // Process messages from full-thread fetch
          const messagesMap: Record<
            string,
            { id: string; snippet: string; date: string }
          > = {};
          for (const message of threadMessages) {
            const messageId = message.id as string;
            totalMsg++;
            if (messageExists(account, threadId, messageId)) {
              // Still record in map for thread.json update
              const msgPayload = message.payload as
                (GmailPayloadPart & { headers?: GmailHeader[] }) | undefined;
              const hdrs = msgPayload?.headers ?? [];
              messagesMap[messageId] = {
                id: messageId,
                snippet: (message.snippet as string | undefined) ?? '',
                date: headerValue(hdrs, 'Date'),
              };
              skipMsg++;
              continue;
            }
            try {
              console.log(`Downloading ${account}/${threadId}/${messageId}`);
              const msgPayload = message.payload as
                (GmailPayloadPart & { headers?: GmailHeader[] }) | undefined;
              const hdrs = msgPayload?.headers ?? [];
              const body = extractTextFromPayload(
                message.payload as GmailPayloadPart,
              );
              const atts = extractAttachments(
                message.payload as GmailPayloadPart,
              );
              saveMessage({
                messageId,
                threadId,
                account,
                subject: headerValue(hdrs, 'Subject'),
                from: headerValue(hdrs, 'From'),
                to: headerValue(hdrs, 'To'),
                cc: headerValue(hdrs, 'Cc'),
                date: headerValue(hdrs, 'Date'),
                internalDateMs: message.internalDate
                  ? Number(message.internalDate)
                  : null,
                labels: message.labelIds ?? [],
                body: { text: body.text, html: body.html },
                attachments: atts.map((a) => ({
                  filename: a.filename,
                  mimeType: a.mimeType,
                  size: a.size,
                })),
                downloadedAt: nowIso(),
              });
              messagesMap[messageId] = {
                id: messageId,
                snippet: (message.snippet as string | undefined) ?? '',
                date: headerValue(hdrs, 'Date'),
              };
              dlMsg++;
              thDl++;
              dlAtt += atts.length;
            } catch (e) {
              console.error(
                `Failed ${messageId}:`,
                e instanceof Error ? e.message : String(e),
              );
              failMsg++;
              thFail++;
            }
          }
          // Update thread.json with messages map so future runs skip the full-thread fetch
          if (Object.keys(messagesMap).length > 0) {
            const threadsDir = getThreadsPath(account, threadId);
            ensureDir(threadsDir);
            const existingThread =
              readJson<Record<string, unknown> | null>(
                path.join(threadsDir, 'thread.json'),
                null,
              ) ?? {};
            writeJsonAtomic(path.join(threadsDir, 'thread.json'), {
              ...existingThread,
              messages: messagesMap,
            });
          }
          if (thDl > 0 || thFail === 0) {
            client.done(qId);
            procTh++;
          } else {
            client.fail(
              qId,
              `Failed to download any messages (${String(thFail)} failed)`,
            );
            failTh++;
          }
          continue;
        }

        for (const messageId of Object.keys(cache!.messages!)) {
          totalMsg++;
          if (messageExists(account, threadId, messageId)) {
            skipMsg++;
            continue;
          }
          try {
            console.log(`Downloading ${account}/${threadId}/${messageId}`);
            const message = downloadMessage(account, messageId);
            if (!message) {
              failMsg++;
              thFail++;
              continue;
            }
            const msgPayload = message.payload as
              (GmailPayloadPart & { headers?: GmailHeader[] }) | undefined;
            const hdrs = msgPayload?.headers ?? [];
            const body = extractTextFromPayload(
              message.payload as GmailPayloadPart,
            );
            const atts = extractAttachments(
              message.payload as GmailPayloadPart,
            );
            saveMessage({
              messageId,
              threadId,
              account,
              subject: headerValue(hdrs, 'Subject'),
              from: headerValue(hdrs, 'From'),
              to: headerValue(hdrs, 'To'),
              cc: headerValue(hdrs, 'Cc'),
              date: headerValue(hdrs, 'Date'),
              internalDateMs: message.internalDate
                ? Number(message.internalDate)
                : null,
              labels: message.labelIds ?? [],
              body: { text: body.text, html: body.html },
              attachments: atts.map((a) => ({
                filename: a.filename,
                mimeType: a.mimeType,
                size: a.size,
              })),
              downloadedAt: nowIso(),
            });
            dlMsg++;
            thDl++;
            dlAtt += atts.length;
            sleepMs(100);
          } catch (e) {
            console.error(
              `Failed ${messageId}:`,
              e instanceof Error ? e.message : String(e),
            );
            failMsg++;
            thFail++;
          }
        }
        if (thDl > 0 || thFail === 0) {
          client.done(qId);
          procTh++;
        } else {
          client.fail(
            qId,
            `Failed to download any messages (${String(thFail)} failed)`,
          );
          failTh++;
        }
      } catch (e) {
        console.error(
          `Failed thread ${threadId}:`,
          e instanceof Error ? e.message : String(e),
        );
        client.fail(qId, e instanceof Error ? e.message : String(e));
        failTh++;
      }
    }

    const stats = {
      at: nowIso(),
      kind: 'download',
      threadsDequeued: items.length,
      processedThreads: procTh,
      failedThreads: failTh,
      totalMessages: totalMsg,
      downloadedMessages: dlMsg,
      downloadedAttachments: dlAtt,
      skippedMessages: skipMsg,
      failedMessages: failMsg,
    };
    ensureDir(EMAIL_EVENTS_DIR);
    appendJsonl(path.join(EMAIL_EVENTS_DIR, '_runs-download.jsonl'), stats);
    console.log(JSON.stringify(stats, null, 2));
  } finally {
    client.close();
  }
}

runScript('email/download', main, EMAIL_EVENTS_DIR);
