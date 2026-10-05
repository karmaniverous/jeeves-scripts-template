/**
 * @module google-drive/lib/plan
 *
 * The pure planner (spec §6.2, §6.4, §6.5, §7): snapshot × ledger ×
 * disk → actions. Nothing here touches the filesystem, gog or runner
 * state, so every rule is unit-testable.
 *
 * - Content changes are detected by probe key (md5 for blobs; revision
 *   id or modifiedTime for Google-native, see content-key.ts), never by
 *   `version`.
 * - The download queue is derived: every snapshot file whose probe key
 *   differs from what was last written, minus skipped/parked/backing-off
 *   items. Updates first (oldest pending), then new files (newest
 *   modifiedTime).
 * - The tree is canonical: files not in the desired set F are deleted
 *   whether or not the ledger knows them, and directories (with their
 *   `.meta/`) survive only while F or queued work lives beneath them.
 * - The mass-deletion guard blocks all deletions on enumeration errors,
 *   or when deletions exceed BOTH `maxFraction` of disk files AND
 *   `minCount`.
 */

import path from 'node:path/posix';

import type { ConversionKind } from './classify.js';
import type { DeletionConfig } from './config.js';
import { emptyRecord, type LedgerRecord, type SkipReason } from './ledger.js';
import type { ShareDirs } from './tree.js';

export interface PlanItem {
  id: string;
  modifiedTime: string | null;
  kind: ConversionKind | null;
  /** Target path relative to targetDir; null when the item can't be placed. */
  desiredPath: string | null;
  /** Skip decided before planning (classification, size, path length). */
  preSkip: SkipReason | null;
  probeKey: string;
  pathResolved: boolean;
  shareIds: string[];
}

export interface PlanInput {
  items: PlanItem[];
  ledger: Map<string, LedgerRecord>;
  /** Files currently under targetDir (relative), `.meta/` contents excluded. */
  diskFiles: string[];
  /** Directories (relative) that currently contain a `.meta/`. */
  diskMetaDirs: string[];
  shareDirs: ShareDirs[];
  enumerationErrors: number;
  now: Date;
  deletion: DeletionConfig;
  allowMassDelete: boolean;
}

export interface QueueEntry {
  id: string;
  isUpdate: boolean;
}

export interface Plan {
  moves: { id: string; from: string; to: string }[];
  queue: QueueEntry[];
  fileDeletes: string[];
  metaDeletes: string[];
  desiredDirs: Set<string>;
  seedCandidates: string[];
  records: Map<string, LedgerRecord>;
  ledgerRemovals: string[];
  guard: { tripped: boolean; reason: string | null; blocked: number };
  /** Deletions the guard blocked (files and meta dirs), for the run state. */
  blockedDeletes: string[];
  parked: string[];
}

/** Every ancestor directory of a relative path, shallowest first. */
export function ancestorDirs(relPath: string): string[] {
  const dirs: string[] = [];
  let dir = path.dirname(relPath);
  while (dir !== '.' && dir !== '') {
    dirs.unshift(dir);
    dir = path.dirname(dir);
  }
  return dirs;
}

interface Classified {
  record: LedgerRecord;
  livePath: string | null;
  pendingNewDir: string | null;
  queued: QueueEntry | null;
}

function classifyItem(
  item: PlanItem,
  prior: LedgerRecord | undefined,
  now: Date,
  onDisk: Set<string>,
): Classified {
  const record: LedgerRecord = {
    ...(prior ?? emptyRecord()),
    pathResolved: item.pathResolved,
    shareIds: item.shareIds,
  };
  // Trust the disk over the ledger. A copy already at its desired path is
  // a move that completed before its record was saved; a copy found
  // nowhere was lost and is downloaded again.
  if (record.written && !(record.localPath && onDisk.has(record.localPath))) {
    if (item.desiredPath && onDisk.has(item.desiredPath)) {
      record.localPath = item.desiredPath;
    } else {
      record.written = null;
      record.localPath = null;
    }
  }
  const nowIso = now.toISOString();

  if (item.preSkip || !item.desiredPath) {
    const reason = item.preSkip ?? 'path-too-long';
    return {
      record: {
        ...record,
        skipped: { reason, key: item.probeKey },
        written: null,
        localPath: null,
        pendingSince: null,
      },
      livePath: null,
      pendingNewDir: null,
      queued: null,
    };
  }
  if (record.skipped && record.skipped.key === item.probeKey) {
    return {
      record: { ...record, written: null, localPath: null },
      livePath: null,
      pendingNewDir: null,
      queued: null,
    };
  }
  record.skipped = null;
  if (record.parked && record.parked.key !== item.probeKey) {
    record.parked = null;
    record.attempts = 0;
    record.lastError = null;
    record.retryAfter = null;
  }

  const written = record.written;
  const livePath = written ? item.desiredPath : null;
  if (written && written.contentKey === item.probeKey) {
    // Metadata-only change (e.g. a rename bumped modifiedTime but the
    // revision is unchanged): remember the new modifiedTime so the next
    // run's first-stage check passes without a revisions call.
    const refreshed = { ...written, modifiedTime: item.modifiedTime };
    return {
      record: { ...record, written: refreshed, pendingSince: null },
      livePath,
      pendingNewDir: null,
      queued: null,
    };
  }

  record.pendingSince ??= nowIso;
  const backingOff = record.retryAfter !== null && record.retryAfter > nowIso;
  const queued =
    record.parked || backingOff
      ? null
      : { id: item.id, isUpdate: written !== null };
  return {
    record,
    livePath,
    pendingNewDir: written ? null : path.dirname(item.desiredPath),
    queued,
  };
}

/** Order the derived queue (spec §6.4). */
function orderQueue(
  entries: QueueEntry[],
  records: Map<string, LedgerRecord>,
  items: Map<string, PlanItem>,
): QueueEntry[] {
  const updates = entries.filter((e) => e.isUpdate);
  const fresh = entries.filter((e) => !e.isUpdate);
  const since = (id: string): string => records.get(id)?.pendingSince ?? '';
  const mtime = (id: string): string => items.get(id)?.modifiedTime ?? '';
  updates.sort(
    (a, b) =>
      since(a.id).localeCompare(since(b.id)) || a.id.localeCompare(b.id),
  );
  fresh.sort(
    (a, b) =>
      mtime(b.id).localeCompare(mtime(a.id)) || a.id.localeCompare(b.id),
  );
  return [...updates, ...fresh];
}

/** Build the plan. Pure. */
export function plan(input: PlanInput): Plan {
  const records = new Map<string, LedgerRecord>();
  const moves: Plan['moves'] = [];
  const entries: QueueEntry[] = [];
  const live = new Set<string>();
  const desiredDirs = new Set<string>();
  const parked: string[] = [];

  const onDisk = new Set(input.diskFiles);
  for (const item of input.items) {
    const prior = input.ledger.get(item.id);
    const c = classifyItem(item, prior, input.now, onDisk);
    records.set(item.id, c.record);
    if (c.record.parked) parked.push(item.id);
    if (c.queued) entries.push(c.queued);
    if (c.livePath) {
      live.add(c.livePath);
      for (const d of ancestorDirs(c.livePath)) desiredDirs.add(d);
      const from = c.record.localPath;
      if (from && from !== c.livePath)
        moves.push({ id: item.id, from, to: c.livePath });
    }
    if (c.pendingNewDir && c.pendingNewDir !== '.') {
      for (const d of [...ancestorDirs(c.pendingNewDir), c.pendingNewDir])
        desiredDirs.add(d);
    }
  }

  const movedFrom = new Set(moves.map((m) => m.from));
  let fileDeletes = input.diskFiles.filter(
    (f) => !live.has(f) && !movedFrom.has(f),
  );
  let metaDeletes = input.diskMetaDirs.filter((d) => !desiredDirs.has(d));

  const total = fileDeletes.length + metaDeletes.length;
  const overFraction =
    total > input.deletion.maxFraction * input.diskFiles.length;
  const overCount = total > input.deletion.minCount;
  let reason: string | null = null;
  if (input.enumerationErrors > 0 && total > 0) reason = 'enumeration-error';
  else if (overFraction && overCount && !input.allowMassDelete)
    reason = 'mass-deletion';
  const blocked = reason ? total : 0;
  const blockedDeletes = reason
    ? [...fileDeletes, ...metaDeletes.map((d) => `${d}/`)].sort()
    : [];
  if (reason) {
    fileDeletes = [];
    metaDeletes = [];
  }
  // Forget unseen items only when their copies really go: after a blocked
  // run (e.g. a transient enumeration failure) a returning item must find
  // its record, not look new and turn its existing copy into a stray.
  const ledgerRemovals = reason
    ? []
    : [...input.ledger.keys()].filter((id) => !records.has(id));

  const seedCandidates = [
    ...new Set(input.shareDirs.flatMap((s) => [s.rootDir, s.sharePointDir])),
  ].sort();

  return {
    moves,
    queue: orderQueue(
      entries,
      records,
      new Map(input.items.map((i) => [i.id, i])),
    ),
    fileDeletes: fileDeletes.sort(),
    metaDeletes: metaDeletes.sort(),
    desiredDirs,
    seedCandidates,
    records,
    ledgerRemovals,
    guard: { tripped: reason !== null, reason, blocked },
    blockedDeletes,
    parked,
  };
}
