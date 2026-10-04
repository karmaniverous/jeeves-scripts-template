#!/usr/bin/env tsx
/**
 * @module drain-updates
 *
 * Dequeue label-change actions from `email-updates` and apply them to
 * Gmail threads via `gog gmail thread modify`.
 *
 * Called on a schedule as an entry-point script. Pre-creates any missing
 * Gmail labels, then processes addLabel/removeLabel/archive/trash/markRead
 * actions with rate limiting (MAX_CALLS_PER_MINUTE). Updates the thread
 * cache provenance on each successful action. Logs run stats to
 * EMAIL_EVENTS_DIR.
 *
 * Depends on EMAIL_EVENTS_DIR for run logging. Rate limit is hardcoded
 * via MAX_CALLS_PER_MINUTE constant. Skips when no gog accounts are
 * configured (getGmailAccounts(): polled Gmail accounts plus
 * emailConfig.backfill.accounts). Fails when there are some but gog has
 * no OAuth client and no service-account mailboxes, whether or not
 * reportOnly is set. Applies nothing (and dequeues nothing) when
 * emailConfig.reportOnly is true. See label-actions.ts planDrain().
 */

import path from 'node:path';

import { appendJsonl, nowIso, runScript, sleepMs } from '@karmaniverous/jeeves';
import { getRunnerClient } from '@karmaniverous/jeeves-runner';

import { EMAIL_EVENTS_DIR } from '../../lib/constants.js';
import { gogWithRetry } from '../../lib/gog.js';
import {
  getGmailAccounts,
  loadPipelineConfig,
} from '../../lib/pipeline-config.js';
import { loadCache, saveCache } from '../email-cache.js';
import {
  EMAIL_UPDATES_QUEUE,
  type LabelChanges,
  labelChangesFor,
  planDrain,
  threadModifyArgs,
} from './label-actions.js';

const MAX_CALLS_PER_MINUTE = 60;

interface UpdateEntry {
  account: string;
  threadId: string;
  messageId: string;
  action: string;
  label?: string;
  source: string;
}

function applyLabelUpdate(entry: UpdateEntry): LabelChanges {
  const changes = labelChangesFor(entry.action, entry.label);
  gogWithRetry(threadModifyArgs(entry.account, entry.threadId, changes), {
    retries: 1,
    backoffMs: 3000,
  });
  return changes;
}

function processEntry(entry: UpdateEntry): {
  success: boolean;
  error?: string;
} {
  try {
    const changes = applyLabelUpdate(entry);
    const cache = loadCache(entry.account, entry.threadId);
    if (cache) {
      const val =
        changes.addLabels.length > 0
          ? `+${changes.addLabels.join(',')}`
          : `-${changes.removeLabels.join(',')}`;
      cache.provenance.push({
        field: 'labels',
        messageId: entry.messageId,
        value: val,
        by: 'jeeves',
        source: entry.source,
        at: nowIso(),
      });
      const msg = cache.messages?.[entry.messageId];
      if (msg) {
        const labels = new Set(msg.labels);
        for (const l of changes.addLabels) labels.add(l);
        for (const l of changes.removeLabels) labels.delete(l);
        msg.labels = Array.from(labels);
      }
      saveCache(cache);
    }
    return { success: true };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function main(): void {
  const plan = planDrain(
    loadPipelineConfig().emailConfig.reportOnly,
    getGmailAccounts().length,
  );
  if (plan === 'report-only') {
    console.log(
      '[report-only] emailConfig.reportOnly is true: no Gmail changes applied; queue left untouched',
    );
    return;
  }
  if (plan === 'skip') {
    console.log('[skip] No Gmail accounts configured');
    return;
  }

  const client = getRunnerClient();
  try {
    const items = client.dequeue(EMAIL_UPDATES_QUEUE, 100);
    if (items.length === 0) {
      console.log('Queue is empty');
      return;
    }

    // Pre-flight: ensure labels exist
    const labelActions = items.filter(
      ({ payload }) =>
        (payload as UpdateEntry).action === 'addLabel' &&
        (payload as UpdateEntry).label,
    );
    const unique = new Map<string, { account: string; label: string }>();
    for (const { payload } of labelActions) {
      const e = payload as UpdateEntry;
      const key = `${e.account}|${e.label!}`;
      if (!unique.has(key))
        unique.set(key, { account: e.account, label: e.label! });
    }
    for (const { account, label } of unique.values()) {
      try {
        const raw = gogWithRetry(
          ['gmail', 'labels', 'list', '--json', '--account', account],
          { retries: 1, backoffMs: 3000 },
        );
        const parsed = raw
          ? (JSON.parse(raw) as { labels?: Array<{ name: string }> })
          : {};
        const existing = (parsed.labels ?? []).map((l) => l.name);
        if (!existing.includes(label)) {
          console.log(`Creating label "${label}" for ${account}`);
          gogWithRetry(
            ['gmail', 'labels', 'create', label, '--account', account],
            { retries: 1, backoffMs: 3000 },
          );
        }
      } catch (e) {
        console.error(
          `Failed label check "${label}" for ${account}:`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }

    const delay = Math.ceil(60000 / MAX_CALLS_PER_MINUTE);
    let processed = 0,
      succeeded = 0,
      failed = 0;

    for (const { id, payload } of items) {
      processed++;
      const entry = payload as UpdateEntry;
      console.log(
        `Processing ${String(processed)}: ${entry.action} ${entry.label ?? ''} on ${entry.messageId}`,
      );
      const result = processEntry(entry);
      if (result.success) {
        client.done(id);
        succeeded++;
      } else {
        client.fail(id, result.error);
        failed++;
      }
      if (processed < items.length) sleepMs(delay);
    }

    const stats = {
      at: nowIso(),
      kind: 'drain_updates',
      processed,
      succeeded,
      failed,
    };
    appendJsonl(path.join(EMAIL_EVENTS_DIR, '_runs.jsonl'), stats);
    console.log(JSON.stringify(stats, null, 2));
  } finally {
    client.close();
  }
}

runScript('email/drain-updates', main, EMAIL_EVENTS_DIR);
