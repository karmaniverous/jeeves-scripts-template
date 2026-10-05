/**
 * @module google-drive/lib/report
 *
 * Pure reporting over a plan: the summary fields a plan determines, and
 * the per-item lines printed by every run (the dry-run output). Kept
 * apart from run-sync.ts so the orchestration reads as a flow and the
 * report is testable on its own.
 */

import type { Plan } from './plan.js';
import type { Prepared } from './prepare.js';
import type { SyncSummary } from './summary.js';

/** Runner-state cap on the blocked-deletion list. */
export const MAX_BLOCKED_LISTED = 500;

/** Summary fields determined by the plan alone. */
export function planSummary(
  prepared: Prepared,
  p: Plan,
): Pick<
  SyncSummary,
  | 'files'
  | 'excluded'
  | 'moves'
  | 'heldMoves'
  | 'fileDeletes'
  | 'metaDeletes'
  | 'guard'
  | 'blockedDeletes'
  | 'queueUpdates'
  | 'queueNew'
  | 'parked'
  | 'skippedItems'
  | 'oldestPending'
> {
  const records = [...p.records.values()];
  const pending = records
    .map((r) => r.pendingSince)
    .filter((s): s is string => s !== null)
    .sort();
  return {
    files: prepared.items.length,
    excluded: prepared.excluded,
    moves: p.moves.length,
    heldMoves: p.heldMoves.length,
    fileDeletes: p.fileDeletes.length,
    metaDeletes: p.metaDeletes.length,
    guard: p.guard,
    blockedDeletes: p.blockedDeletes.slice(0, MAX_BLOCKED_LISTED),
    queueUpdates: p.queue.filter((q) => q.isUpdate).length,
    queueNew: p.queue.filter((q) => !q.isUpdate).length,
    parked: p.parked.length,
    skippedItems: records.filter((r) => r.skipped).length,
    oldestPending: pending[0] ?? null,
  };
}

/** One line per planned action, in apply order. */
export function planLines(prepared: Prepared, p: Plan): string[] {
  const pathOf = new Map(prepared.items.map((i) => [i.id, i.desiredPath]));
  const lines: string[] = [];
  for (const m of p.moves) lines.push(`MOVE ${m.from} -> ${m.to}`);
  for (const m of p.heldMoves)
    lines.push(`HOLD ${m.from} (would move to ${m.to}; enumeration errors)`);
  for (const f of p.fileDeletes) lines.push(`DELETE ${f}`);
  for (const d of p.metaDeletes) lines.push(`DELETE-DIR (with .meta) ${d}`);
  for (const q of p.queue) {
    lines.push(`${q.isUpdate ? 'UPDATE' : 'NEW'} ${pathOf.get(q.id) ?? q.id}`);
  }
  for (const [id, r] of p.records) {
    if (r.skipped) lines.push(`SKIP(${r.skipped.reason}) ${id}`);
  }
  for (const s of p.seedCandidates) lines.push(`META-CANDIDATE ${s}`);
  return lines;
}
