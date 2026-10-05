/**
 * @module google-drive/lib/summary
 *
 * The per-sync run summary: logged as one `JR_RESULT:{"meta": …}` line
 * (the runner keeps only the last 100 stdout lines and parses that
 * prefix) and saved in full to the `run:<account>` state entry
 * (spec §6.4).
 */

export interface SyncSummary {
  account: string;
  live: boolean;
  shares: number;
  files: number;
  excluded: number;
  moves: number;
  /** Moves held back because the run had enumeration errors. */
  heldMoves: number;
  fileDeletes: number;
  metaDeletes: number;
  guard: { tripped: boolean; reason: string | null; blocked: number };
  /** Guard-blocked deletions (first 500), for operator review. */
  blockedDeletes: string[];
  queueUpdates: number;
  queueNew: number;
  parked: number;
  skippedItems: number;
  oldestPending: string | null;
  processed: number;
  failed: number;
  skipped: number;
  bytes: number;
  remaining: number;
  removedDirs: number;
  heldLocks: string[];
  seeded: number;
  seedErrors: string[];
  enumerationErrors: string[];
  unresolvedShares: string[];
}

export function emptySummary(account: string, live: boolean): SyncSummary {
  return {
    account,
    live,
    shares: 0,
    files: 0,
    excluded: 0,
    moves: 0,
    heldMoves: 0,
    fileDeletes: 0,
    metaDeletes: 0,
    guard: { tripped: false, reason: null, blocked: 0 },
    blockedDeletes: [],
    queueUpdates: 0,
    queueNew: 0,
    parked: 0,
    skippedItems: 0,
    oldestPending: null,
    processed: 0,
    failed: 0,
    skipped: 0,
    bytes: 0,
    remaining: 0,
    removedDirs: 0,
    heldLocks: [],
    seeded: 0,
    seedErrors: [],
    enumerationErrors: [],
    unresolvedShares: [],
  };
}

/** Compact one-line metadata for `JR_RESULT`. */
export function compactMeta(summaries: SyncSummary[]): string {
  return summaries
    .map((s) =>
      [
        s.account,
        s.live ? 'live' : 'dry',
        `shares=${String(s.shares)}`,
        `files=${String(s.files)}`,
        `queue=${String(s.queueUpdates)}u/${String(s.queueNew)}n/${String(s.parked)}p`,
        `done=${String(s.processed)}`,
        `failed=${String(s.failed)}`,
        `left=${String(s.remaining)}`,
        `del=${String(s.fileDeletes)}f/${String(s.metaDeletes)}m`,
        `moved=${String(s.moves)}`,
        s.heldMoves ? `held=${String(s.heldMoves)}` : '',
        `seeded=${String(s.seeded)}`,
        s.guard.tripped
          ? `GUARD=${s.guard.reason ?? ''}:${String(s.guard.blocked)}`
          : '',
        s.enumerationErrors.length
          ? `enumErr=${String(s.enumerationErrors.length)}`
          : '',
        s.heldLocks.length ? `locks=${String(s.heldLocks.length)}` : '',
      ]
        .filter(Boolean)
        .join(' '),
    )
    .join('; ');
}

/** Exit code: non-zero only for conditions that need a human (spec §6.4). */
export function exitCodeFor(summaries: SyncSummary[]): number {
  return summaries.some(
    (s) => s.guard.tripped || s.enumerationErrors.length > 0,
  )
    ? 2
    : 0;
}
