/**
 * @module google-drive/lib/run-sync
 *
 * One sync entry, end to end (spec §4–§7): enumerate → prepare → plan →
 * (live only) deletes, moves, ledger updates, budgeted downloads,
 * directory pruning, meta seeding. A dry run stops after planning and
 * writes nothing to disk or runner state.
 */

import path from 'node:path';

import type { RunnerClient } from '@karmaniverous/jeeves-runner';

import { CONTENT_DIR, JEEVES_BASE_DIR } from '../../lib/constants.js';
import {
  assertNoSymlinks,
  deleteFiles,
  moveFile,
  prepareStaging,
  pruneDirs,
  scanTree,
} from './apply.js';
import { resolveTargetDir, type SyncEntryConfig } from './config.js';
import { createDriveClient, type DriveClient } from './drive-client.js';
import { enumerate } from './enumerate.js';
import { runQueue } from './execute.js';
import { createLedgerStore } from './ledger.js';
import type { FetchLike } from './meta-seed.js';
import { plan } from './plan.js';
import { prepare } from './prepare.js';
import { planLines, planSummary } from './report.js';
import { createPathResolver } from './resolve-path.js';
import { seedShareMetas } from './seed-metas.js';
import { emptySummary, type SyncSummary } from './summary.js';

export interface SyncOptions {
  live: boolean;
  allowMassDelete: boolean;
  deadline: number;
  shouldStop: () => boolean;
  log: (line: string) => void;
  /** Seams (tests): default to gog, the instance content dir, the state dir and global fetch. */
  client?: DriveClient;
  contentDir?: string;
  stagingRoot?: string;
  fetchFn?: FetchLike;
  now?: () => Date;
}

export async function syncOne(
  cfg: SyncEntryConfig,
  runner: RunnerClient,
  opts: SyncOptions,
): Promise<SyncSummary> {
  const summary = emptySummary(cfg.account, opts.live);
  const now = opts.now ?? (() => new Date());
  const targetDir = resolveTargetDir(
    cfg.targetDir,
    opts.contentDir ?? CONTENT_DIR,
  );
  const client = opts.client ?? createDriveClient(cfg.account);
  const store = createLedgerStore(runner, cfg.account, opts.live);

  const snapshot = enumerate(
    client,
    createPathResolver(client, cfg.pathResolution),
  );
  summary.shares = snapshot.shares.length;
  summary.enumerationErrors = snapshot.errors;
  summary.unresolvedShares = snapshot.shares
    .filter((s) => !s.pathResolved)
    .map((s) => s.id);

  const ledger = store.load();
  const prepared = prepare(snapshot, ledger, client, cfg, targetDir);
  assertNoSymlinks(opts.contentDir ?? CONTENT_DIR, targetDir);
  const scan = scanTree(targetDir);
  const p = plan({
    items: prepared.items,
    ledger,
    diskFiles: scan.files,
    diskMetaDirs: scan.metaDirs,
    shareDirs: prepared.shareDirs,
    enumerationErrors: snapshot.errors.length,
    now: now(),
    deletion: cfg.deletion,
    allowMassDelete: opts.allowMassDelete,
  });
  Object.assign(summary, planSummary(prepared, p));
  for (const line of planLines(prepared, p)) opts.log(line);
  if (!opts.live) return summary;

  const stagingRoot =
    opts.stagingRoot ??
    path.join(JEEVES_BASE_DIR, 'state', 'google-drive', 'tmp');
  const stagingDir = path.join(stagingRoot, cfg.account);
  prepareStaging(stagingDir, targetDir);

  deleteFiles(targetDir, p.fileDeletes);
  for (const m of p.moves) {
    moveFile(targetDir, m.from, m.to);
    const rec = p.records.get(m.id);
    if (rec) {
      rec.localPath = m.to;
      store.put(m.id, rec); // per move: an interruption loses at most this one
    }
  }
  for (const [id, rec] of p.records) store.put(id, rec);
  for (const id of p.ledgerRemovals) store.remove(id);

  Object.assign(
    summary,
    await runQueue({
      queue: p.queue,
      items: new Map(prepared.items.map((i) => [i.id, i])),
      files: prepared.files,
      kinds: prepared.kinds,
      records: p.records,
      store,
      client,
      targetDir,
      stagingDir,
      budget: cfg.budget,
      sheets: cfg.conversion.sheets,
      deadline: opts.deadline,
      shouldStop: opts.shouldStop,
      now,
    }),
  );

  const pruned = pruneDirs(
    targetDir,
    p.desiredDirs,
    p.metaDeletes,
    cfg.meta.lockStaleMinutes,
  );
  summary.removedDirs = pruned.removedDirs.length;
  summary.heldLocks = pruned.heldLocks;

  const rootDirs = new Set(prepared.shareDirs.map((s) => s.rootDir));
  const seeded = await seedShareMetas(
    targetDir,
    p.seedCandidates,
    rootDirs,
    cfg.meta,
    opts.fetchFn,
  );
  summary.seeded = seeded.seeded;
  summary.seedErrors = seeded.errors;
  return summary;
}
