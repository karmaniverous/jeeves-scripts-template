/**
 * @module google-drive/lib/execute
 *
 * Work the derived download queue within the run budget (spec §6.4):
 * stop before starting an item once time, item or byte limits are
 * reached (or a stop was requested by SIGTERM). Each finished item's
 * ledger record is written immediately, so a hard kill loses at most
 * the in-flight item.
 *
 * Failure policy: `SkipError` → permanent skip until the content key
 * changes; anything else → attempts+1 with exponential backoff, parked
 * after `maxAttempts`.
 */

import fs from 'node:fs';
import path from 'node:path';

import { writeAtomic } from './apply.js';
import type { ConversionKind } from './classify.js';
import type { BudgetConfig, SheetsConversionConfig } from './config.js';
import { writtenKey } from './content-key.js';
import { materialize, SkipError } from './convert.js';
import type { DriveClient } from './drive-client.js';
import { wantsFrontmatter, withFrontmatter } from './frontmatter.js';
import type { LedgerRecord, LedgerStore } from './ledger.js';
import type { NamingClass } from './naming.js';
import type { PlanItem, QueueEntry } from './plan.js';
import type { SnapshotFile } from './types.js';

const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

export interface QueueContext {
  queue: QueueEntry[];
  items: Map<string, PlanItem>;
  files: Map<string, SnapshotFile>;
  kinds: Map<string, { kind: ConversionKind; namingClass: NamingClass }>;
  records: Map<string, LedgerRecord>;
  store: LedgerStore;
  client: DriveClient;
  targetDir: string;
  stagingDir: string;
  budget: BudgetConfig;
  sheets: SheetsConversionConfig;
  deadline: number;
  shouldStop: () => boolean;
  now?: () => Date;
}

export interface QueueStats {
  processed: number;
  failed: number;
  skipped: number;
  bytes: number;
  remaining: number;
}

/** Exponential backoff: 1, 2, 4 … minutes, capped at 6 h. */
export function backoffMs(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts - 1) * 60_000, MAX_BACKOFF_MS);
}

export async function runQueue(ctx: QueueContext): Promise<QueueStats> {
  const stats: QueueStats = {
    processed: 0,
    failed: 0,
    skipped: 0,
    bytes: 0,
    remaining: 0,
  };
  const now = ctx.now ?? (() => new Date());

  for (let i = 0; i < ctx.queue.length; i++) {
    // Materialising is mostly synchronous; yield a macrotask so a pending
    // SIGTERM handler can run before the stop check.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const outOfBudget =
      ctx.shouldStop() ||
      Date.now() >= ctx.deadline ||
      (ctx.budget.maxItems !== null &&
        stats.processed + stats.failed + stats.skipped >=
          ctx.budget.maxItems) ||
      (ctx.budget.maxBytes !== null && stats.bytes >= ctx.budget.maxBytes);
    if (outOfBudget) {
      stats.remaining = ctx.queue.length - i;
      break;
    }

    const { id } = ctx.queue[i];
    const item = ctx.items.get(id);
    const file = ctx.files.get(id);
    const kind = ctx.kinds.get(id);
    const record = ctx.records.get(id);
    if (!item?.desiredPath || !file || !kind || !record) continue;

    const scratch = path.join(ctx.stagingDir, `${String(i)}.dl`);
    const out = path.join(ctx.stagingDir, `${String(i)}.out`);
    try {
      // Read the key *before* exporting: an edit that lands mid-export then
      // shows up as a newer key next run instead of hiding behind this one.
      const contentKey = writtenKey(file.file, kind.namingClass, ctx.client);
      const body = await materialize(
        kind.kind,
        file.file,
        ctx.client,
        scratch,
        ctx.sheets,
      );
      const content = wantsFrontmatter(kind.kind)
        ? withFrontmatter(file, body)
        : body;
      writeAtomic(ctx.targetDir, item.desiredPath, content, out);
      Object.assign(record, {
        localPath: item.desiredPath,
        written: {
          contentKey,
          modifiedTime: file.file.modifiedTime ?? null,
          kind: kind.kind,
          at: now().toISOString(),
        },
        skipped: null,
        pendingSince: null,
        attempts: 0,
        lastError: null,
        retryAfter: null,
        parked: null,
      });
      stats.processed++;
      stats.bytes += Buffer.byteLength(content, 'utf8');
    } catch (err) {
      if (err instanceof SkipError) {
        // Don't delete the old copy here: forgetting it makes it a stray,
        // which the next plan deletes under the mass-deletion guard.
        Object.assign(record, {
          skipped: { reason: err.reason, key: item.probeKey },
          written: null,
          localPath: null,
          pendingSince: null,
        });
        stats.skipped++;
      } else {
        const attempts = record.attempts + 1;
        Object.assign(record, {
          attempts,
          lastError: err instanceof Error ? err.message : String(err),
          retryAfter: new Date(
            now().getTime() + backoffMs(attempts),
          ).toISOString(),
          parked:
            attempts >= ctx.budget.maxAttempts ? { key: item.probeKey } : null,
        });
        stats.failed++;
      }
    } finally {
      fs.rmSync(out, { force: true });
    }
    ctx.store.put(id, record);
  }
  return stats;
}
