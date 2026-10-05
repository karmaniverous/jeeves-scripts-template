/**
 * @module google-drive/lib/execute
 *
 * Work the derived download queue within the run budget (spec §6.4):
 * stop before starting an item once the run's time, item or byte limits
 * are reached (or a stop was requested by SIGTERM). The budget is shared
 * by every sync in the run, so a later sync gets what an earlier one left. Each finished item's
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

/**
 * The run budget, shared by every sync in the run (spec §6.4): one
 * deadline, and item and byte counts that accumulate across syncs.
 */
export interface RunBudget {
  limits: BudgetConfig;
  /** Epoch ms at which the run's time budget ends. */
  deadline: number;
  /** Downloads attempted and bytes written so far, across all syncs. */
  spent: { items: number; bytes: number };
}

/** A fresh run budget whose clock started at `startedAt` (epoch ms). */
export function createRunBudget(
  limits: BudgetConfig,
  startedAt: number,
): RunBudget {
  return {
    limits,
    deadline: startedAt + limits.maxSeconds * 1000,
    spent: { items: 0, bytes: 0 },
  };
}

/** True once the run's time, item or byte budget is used up. */
export function budgetExhausted(b: RunBudget, now = Date.now()): boolean {
  return (
    now >= b.deadline ||
    (b.limits.maxItems !== null && b.spent.items >= b.limits.maxItems) ||
    (b.limits.maxBytes !== null && b.spent.bytes >= b.limits.maxBytes)
  );
}

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
  budget: RunBudget;
  sheets: SheetsConversionConfig;
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
    if (ctx.shouldStop() || budgetExhausted(ctx.budget)) {
      stats.remaining = ctx.queue.length - i;
      break;
    }

    const { id } = ctx.queue[i];
    const item = ctx.items.get(id);
    const file = ctx.files.get(id);
    const kind = ctx.kinds.get(id);
    const record = ctx.records.get(id);
    if (!item?.desiredPath || !file || !kind || !record) continue;

    ctx.budget.spent.items++;
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
      const bytes = Buffer.byteLength(content, 'utf8');
      stats.bytes += bytes;
      ctx.budget.spent.bytes += bytes;
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
            attempts >= ctx.budget.limits.maxAttempts
              ? { key: item.probeKey }
              : null,
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
