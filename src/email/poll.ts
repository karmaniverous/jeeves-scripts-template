#!/usr/bin/env tsx
/**
 * @module poll
 *
 * Unified email poller — dispatches by account type. Accounts without an
 * `imap` block are polled via the gog CLI (Gmail via OAuth client or
 * service-account mailboxes). Accounts with an
 * `imap` block are polled via direct IMAP connection.
 *
 * Called on a schedule as an entry-point script. For gog accounts: searches
 * via `gog gmail search`, runs triage classification, enqueues for download.
 * For IMAP accounts: connects, fetches, parses MIME, writes directly to disk.
 * Trims old JSONL logs after 7 days.
 *
 * Depends on EMAIL_EVENTS_DIR, emailConfig.reportOnly, and bucket domain
 * config from pipeline-config. Missing config causes classification to
 * return null buckets (labels skipped). When reportOnly is true, threads
 * are still ingested but no Gmail label actions (classification or
 * curation-signal) are enqueued. Search output is schema-validated by
 * google-workspace/gmail-search.ts. gog
 * accounts work with an OAuth client or service-account mailboxes; if
 * gog accounts are configured and neither exists, the run fails.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  appendJsonl,
  ensureDir,
  nowIso,
  runScript,
} from '@karmaniverous/jeeves';
import { getRunnerClient } from '@karmaniverous/jeeves-runner';

import { EMAIL_EVENTS_DIR } from '../lib/constants.js';
import { gogWithRetry } from '../lib/gog.js';
import { requireGogCredentials } from '../lib/gog-credentials.js';
import { loadPipelineConfig } from '../lib/pipeline-config.js';
import {
  getThreadState,
  loadScalarState,
  saveScalarState,
  setThreadState,
} from './email-state.js';
import { fetchThreadMetadata } from './google-workspace/email-fetch.js';
import {
  classifyBucket,
  computeLabelsToApply,
  isJunkCandidate,
  isReceiptCandidate,
  looksImportantBySummary,
} from './google-workspace/email-triage.js';
import {
  parseSearchPage,
  searchArgs,
} from './google-workspace/gmail-search.js';
import { enqueueLabelActions } from './google-workspace/label-actions.js';
import { pollImapAccount } from './imap/poll.js';

async function main(): Promise<void> {
  const config = loadPipelineConfig();
  const allAccounts = config.accounts.filter((a) => a.emailPolling);
  const gogAccounts = allAccounts.filter((a) => !a.imap);
  const imapAccounts = allAccounts.filter((a) => a.imap);

  const reportOnly = config.emailConfig.reportOnly;
  const query = 'in:anywhere';
  const max = 100;
  const client = getRunnerClient();

  try {
    ensureDir(EMAIL_EVENTS_DIR);

    // ── IMAP accounts ──────────────────────────────────────────────
    for (const account of imapAccounts) {
      console.log(`[imap] Polling ${account.email}`);
      try {
        const s = await pollImapAccount(account, client);
        appendJsonl(path.join(EMAIL_EVENTS_DIR, '_runs-imap-poll.jsonl'), {
          at: nowIso(),
          kind: 'imap-poll',
          account: account.email,
          fetched: s.fetched,
          written: s.written,
          skipped: s.skipped,
          failed: s.failed,
          folders: s.folders,
        });
      } catch (e) {
        console.error(
          `[imap] ${account.email} error: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // ── gog accounts ───────────────────────────────────────────────
    // Throws (failed run) when Gmail accounts exist but gog has neither
    // an OAuth client nor service-account mailboxes.
    const hasGog = requireGogCredentials('email/poll', gogAccounts.length);
    if (reportOnly && hasGog) {
      console.log('[gog] reportOnly: no Gmail label actions will be enqueued');
    }

    for (const acctCfg of hasGog ? gogAccounts : []) {
      const account = acctCfg.email;
      const state = loadScalarState(account, client);

      const { threads } = parseSearchPage(
        gogWithRetry(searchArgs(account, query, max), {
          retries: 2,
          backoffMs: 5000,
        }),
        account,
      );
      let newC = 0,
        updC = 0,
        fetchC = 0,
        msgC = 0,
        lblC = 0;

      for (const t of threads) {
        const {
          threadId: tid,
          subject: subj,
          snippet: snip,
          from,
          to,
          date,
          messageCount: mc,
          labels,
        } = t;

        const rc = isReceiptCandidate(subj, snip, from, account);
        const jc = !rc && isJunkCandidate(subj, snip, from);
        const bucket = classifyBucket(account, to, subj, snip, from);
        const prev = getThreadState(client, account, tid);
        const isUpd =
          !!prev &&
          ((mc != null &&
            prev.messageCount != null &&
            mc > prev.messageCount) ||
            (date != null && prev.date != null && date !== prev.date));

        if (!prev) {
          appendJsonl(path.join(EMAIL_EVENTS_DIR, `${account}.jsonl`), {
            at: nowIso(),
            kind: 'thread',
            account,
            threadId: tid,
            subject: subj,
            from,
            snippet: snip,
            date,
            messageCount: mc,
            labels,
            receiptCandidate: rc,
            junkCandidate: jc,
            bucket,
            source: 'poll',
            query,
          });
          newC++;
        } else if (isUpd) {
          appendJsonl(path.join(EMAIL_EVENTS_DIR, `${account}.jsonl`), {
            at: nowIso(),
            kind: 'thread_update',
            account,
            threadId: tid,
            subject: subj,
            from,
            snippet: snip,
            date,
            messageCount: mc,
            labels,
            prev: {
              date: prev.date,
              messageCount: prev.messageCount,
              labels: prev.labels,
              seenAt: prev.seenAt,
            },
            receiptCandidate: rc,
            junkCandidate: jc,
            bucket,
            source: 'poll',
            query,
          });
          updC++;
        }

        // Determine which labels need enqueuing (new or changed classifications only)
        const classChanged =
          !prev ||
          prev.receiptCandidate !== rc ||
          prev.junkCandidate !== jc ||
          prev.bucket !== bucket;
        const labelApplied: Record<string, string> = {
          ...(prev?.labelApplied || {}),
        };
        let labelC = 0;

        if (classChanged) {
          const msgId =
            (prev?.seenMessageIds && Object.keys(prev.seenMessageIds)[0]) ||
            tid;
          const labelsToApply = computeLabelsToApply({
            receiptCandidate: rc,
            junkCandidate: jc,
            bucket,
            labelApplied,
          });

          const r = enqueueLabelActions(client, {
            account,
            messageId: msgId,
            threadId: tid,
            labels: labelsToApply,
            source: 'poll-classification',
            reason: 'Auto-label from triage classification',
            reportOnly,
          });
          Object.assign(labelApplied, r.applied);
          labelC += r.enqueued;
        }
        lblC += labelC;

        setThreadState(client, account, tid, {
          ...(prev || {}),
          seenAt: nowIso(),
          date: date ?? undefined,
          messageCount: mc ?? undefined,
          labels,
          receiptCandidate: rc,
          junkCandidate: jc,
          bucket,
          labelApplied,
        });

        if (
          (!prev || isUpd) &&
          looksImportantBySummary({
            labels,
            receiptCandidate: rc,
            bucket,
          })
        ) {
          const r = fetchThreadMetadata({
            account,
            threadId: tid,
            subject: subj,
            from,
            to,
            receiptCandidate: rc,
            junkCandidate: jc,
            bucket,
            labels,
            query,
            client,
            reportOnly,
          });
          fetchC++;
          msgC += r.newMessages;
        }
      }

      saveScalarState(state, client);
      appendJsonl(path.join(EMAIL_EVENTS_DIR, `_runs-${account}.jsonl`), {
        at: nowIso(),
        kind: 'poll',
        account,
        fetched: threads.length,
        new: newC,
        updated: updC,
        deepFetchedThreads: fetchC,
        newMessages: msgC,
        labelsEnqueued: lblC,
        reportOnly,
        query,
        max,
      });
    }

    trimJsonlFiles(EMAIL_EVENTS_DIR, 7);
  } finally {
    client.close();
  }
}

function trimJsonlFiles(dir: string, maxDays: number): void {
  if (!fs.existsSync(dir)) return;
  const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;

  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.jsonl')) continue;
    if (entry.startsWith('_runs-')) continue;

    const filePath = path.join(dir, entry);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const kept: string[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as { at?: string };
        if (obj.at && new Date(obj.at).getTime() >= cutoff) {
          kept.push(line);
        }
      } catch {
        kept.push(line);
      }
    }

    fs.writeFileSync(filePath, kept.length > 0 ? kept.join('\n') + '\n' : '');
  }
}

runScript('email/poll', main, EMAIL_EVENTS_DIR);
