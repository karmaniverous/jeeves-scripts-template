/**
 * @module email-fetch
 *
 * Fetch full thread metadata from Gmail, update the thread cache and
 * provenance, detect label changes, and enqueue threads for body download.
 *
 * Called by poll.ts and backfill-window.ts. Fetches via
 * `gog gmail thread get`, builds CacheMessages, detects human label
 * curation signals (enqueued on `email-updates` unless
 * `emailConfig.reportOnly`, via label-actions.ts), manages pending
 * follow-up tracking, and enqueues to `email-pending` for download.
 *
 * Depends on EMAIL_EVENTS_DIR for event logging and pipeline-config
 * bucket settings for triage decisions.
 */

import path from 'node:path';

import { appendJsonl, ensureDir, nowIso } from '@karmaniverous/jeeves';
import type { RunnerClient } from '@karmaniverous/jeeves-runner';

import { EMAIL_EVENTS_DIR } from '../../lib/constants.js';
import {
  type GmailHeader,
  type GmailPayloadPart,
  headerValue,
} from '../../lib/email.js';
import { gogWithRetry } from '../../lib/gog.js';
import {
  type CacheMessage,
  createOrUpdateCache,
  detectLabelChanges,
  loadCache,
  type ProvenanceEntry,
} from '../email-cache.js';
import {
  type EmailStoreClient,
  getThreadState,
  setThreadState,
} from '../email-state.js';
import { pendingKey, shouldExpectResponse } from './email-triage.js';
import { curationSignalActions, enqueueEmailUpdates } from './label-actions.js';

interface GmailMessage {
  id: string;
  internalDate?: string;
  payload?: GmailPayloadPart & { headers?: GmailHeader[] };
  labelIds?: string[];
  snippet?: string;
}

/** Insert or merge a pending follow-up entry in the runner store. */
export function upsertPending(
  client: Pick<RunnerClient, 'getItem' | 'setItem'>,
  item: Record<string, unknown>,
): void {
  const k = item.key as string;
  const existingJson = client.getItem('email', 'pending', k);
  const existing = existingJson
    ? (JSON.parse(existingJson) as Record<string, unknown>)
    : {};
  client.setItem(
    'email',
    'pending',
    k,
    JSON.stringify({ ...existing, ...item }),
  );
}

/**
 * Fetch full thread from Gmail, update cache/provenance, detect label
 * curation, and enqueue for body download if new messages exist.
 */
export function fetchThreadMetadata(params: {
  account: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  receiptCandidate: boolean;
  junkCandidate: boolean;
  bucket: string | null;
  labels: string[];
  query: string;
  client: EmailStoreClient;
  /** When true, curation signals are detected but not enqueued. */
  reportOnly: boolean;
}): { newMessages: number } {
  const { account, threadId, query, client } = params;
  const prevObj = getThreadState(client, account, threadId);
  const lastInternalDateMs = prevObj?.lastInternalDateMs ?? null;
  let seenMessageIds: Record<string, string> =
    prevObj?.seenMessageIds && typeof prevObj.seenMessageIds === 'object'
      ? prevObj.seenMessageIds
      : {};

  const raw = gogWithRetry(
    ['gmail', 'thread', 'get', threadId, '--json', '--account', account],
    { retries: 2, backoffMs: 5000 },
  );
  const payload = raw
    ? (JSON.parse(raw) as { thread?: { messages?: GmailMessage[] } })
    : {};
  const messages = payload.thread?.messages ?? [];
  let newMessages = 0;
  let latestOutMs: number | null = null;
  let latestInMs: number | null = null;
  let latestOutMeta: { subject: string; from: string; to: string } | null =
    null;

  const participantSet = new Set<string>();
  const cacheMessages: Record<string, CacheMessage> = {};
  const provenance: ProvenanceEntry[] = [];

  for (const m of messages) {
    const msgId = m.id || '';
    if (!msgId) continue;
    const intMs = m.internalDate ? Number(m.internalDate) : null;
    const hdrs = m.payload?.headers ?? [];
    const from = headerValue(hdrs, 'From');
    const to = headerValue(hdrs, 'To');
    const cc = headerValue(hdrs, 'Cc');
    const subj = headerValue(hdrs, 'Subject') || params.subject;
    const dateH = headerValue(hdrs, 'Date');
    const lids = m.labelIds ?? [];
    const dir = lids.includes('SENT') ? 'outgoing' : 'incoming';
    const snip = m.snippet || '';

    [from, to, cc].forEach((a) => {
      if (!a) return;
      a.split(',').forEach((x) => {
        if (x.trim()) participantSet.add(x.trim());
      });
    });

    const atts: CacheMessage['attachments'] = [];
    if (m.payload) {
      const walk = (p: GmailPayloadPart): void => {
        if (p.filename && p.body)
          atts.push({
            filename: p.filename,
            mimeType: p.mimeType ?? '',
            size: p.body.size ?? 0,
          });
        p.parts?.forEach(walk);
      };
      walk(m.payload);
    }

    const cache = loadCache(account, threadId);
    const cached = cache?.messages?.[msgId]?.labels;
    if (cached) {
      provenance.push(...detectLabelChanges(cached, lids, msgId));
      enqueueEmailUpdates(
        client,
        curationSignalActions({
          account,
          threadId,
          messageId: msgId,
          cachedLabels: cached,
          currentLabels: lids,
          seenBefore: !!seenMessageIds[msgId],
        }),
        params.reportOnly,
      );
    }

    cacheMessages[msgId] = {
      messageId: msgId,
      from,
      to,
      cc,
      date: dateH || null,
      internalDateMs: intMs,
      labels: lids,
      snippet: snip,
      hasAttachments: atts.length > 0,
      attachments: atts,
    };

    if (
      !seenMessageIds[msgId] &&
      (lastInternalDateMs == null ||
        intMs == null ||
        intMs > lastInternalDateMs)
    ) {
      newMessages++;
      ensureDir(EMAIL_EVENTS_DIR);
      appendJsonl(path.join(EMAIL_EVENTS_DIR, `${account}.jsonl`), {
        at: nowIso(),
        kind: 'message',
        account,
        threadId,
        messageId: msgId,
        internalDateMs: intMs,
        date: dateH || null,
        subject: subj,
        from,
        to,
        cc,
        labels: lids,
        direction: dir,
        snippet: snip,
        triage: {
          query,
          receiptCandidate: params.receiptCandidate,
          junkCandidate: params.junkCandidate,
          bucket: params.bucket,
          threadLabels: params.labels,
        },
        source: 'thread_get_metadata',
      });
    }
    seenMessageIds[msgId] = nowIso();

    if (intMs != null) {
      if (dir === 'outgoing') {
        if (latestOutMs == null || intMs > latestOutMs) {
          latestOutMs = intMs;
          latestOutMeta = { subject: subj, from, to };
        }
      } else if (latestInMs == null || intMs > latestInMs) latestInMs = intMs;
    }
  }

  createOrUpdateCache({
    account,
    threadId,
    subject: params.subject,
    participants: Array.from(participantSet),
    messages: cacheMessages,
    provenance,
  });

  if (newMessages > 0)
    client.enqueue('email-pending', {
      account,
      threadId,
      subject: params.subject,
      newMessages,
      createdAt: nowIso(),
    });

  // Update pending follow-ups
  const k = pendingKey(account, threadId);
  const expect = shouldExpectResponse({
    subject: params.subject,
    from: params.from,
    to: latestOutMeta?.to ?? '',
    receiptCandidate: params.receiptCandidate,
    junkCandidate: params.junkCandidate,
  });
  if (
    latestOutMs != null &&
    (latestInMs == null || latestInMs < latestOutMs) &&
    expect
  )
    upsertPending(client, {
      key: k,
      account,
      threadId,
      subject: params.subject || latestOutMeta?.subject || '',
      from: latestOutMeta?.from || '',
      to: latestOutMeta?.to || '',
      pendingSince: new Date(latestOutMs).toISOString(),
      status: 'pending',
      noResponseNeeded: false,
      updatedAt: nowIso(),
    });
  if (latestOutMs != null && latestInMs != null && latestInMs > latestOutMs)
    upsertPending(client, {
      key: k,
      account,
      threadId,
      status: 'resolved',
      resolvedAt: nowIso(),
      updatedAt: nowIso(),
    });

  // Update state
  let maxI = lastInternalDateMs;
  for (const m of messages) {
    const ms = m.internalDate ? Number(m.internalDate) : null;
    if (ms != null && (maxI == null || ms > maxI)) maxI = ms;
  }

  const ids = Object.keys(seenMessageIds);
  if (ids.length > 2000) {
    ids.sort(
      (a, b) => Date.parse(seenMessageIds[b]) - Date.parse(seenMessageIds[a]),
    );
    const keep = new Set(ids.slice(0, 2000));
    const pruned: Record<string, string> = {};
    for (const id of keep) {
      pruned[id] = seenMessageIds[id];
    }
    seenMessageIds = pruned;
  }

  setThreadState(client, account, threadId, {
    ...(prevObj || {}),
    lastInternalDateMs: maxI,
    seenMessageIds,
    fetchedAt: nowIso(),
  });

  return { newMessages };
}
