/**
 * @module google-drive/lib/prepare
 *
 * Turn the remote snapshot into planner input (spec §3, §5, §6.2, §8):
 * apply `exclude` globs to the sanitized Drive path, classify each
 * file, lay out local paths, apply pre-download skips (non-convertible,
 * oversize, path too long) and compute probe keys.
 */

import path from 'node:path';

import { classify, type ConversionKind } from './classify.js';
import type { SyncEntryConfig } from './config.js';
import { probeKey } from './content-key.js';
import type { DriveClient } from './drive-client.js';
import type { Snapshot } from './enumerate.js';
import { driveSegments } from './frontmatter.js';
import type { LedgerRecord, SkipReason } from './ledger.js';
import { type NamingClass, sanitizeSegment } from './naming.js';
import type { PlanItem } from './plan.js';
import { layout, type ShareDirs } from './tree.js';
import type { SnapshotFile } from './types.js';

export interface Prepared {
  items: PlanItem[];
  files: Map<string, SnapshotFile>;
  kinds: Map<string, { kind: ConversionKind; namingClass: NamingClass }>;
  shareDirs: ShareDirs[];
  excluded: number;
}

/** Sanitized, untagged Drive path used by `exclude` globs (spec §8). */
export function excludePath(f: SnapshotFile): string {
  return driveSegments(f).map(sanitizeSegment).join('/');
}

export function prepare(
  snapshot: Snapshot,
  ledger: Map<string, LedgerRecord>,
  client: DriveClient,
  cfg: SyncEntryConfig,
  targetDir: string,
): Prepared {
  const kept = snapshot.files.filter(
    // POSIX glob semantics on every platform: excludePath is '/'-joined.
    (f) => !cfg.exclude.some((g) => path.posix.matchesGlob(excludePath(f), g)),
  );

  const kinds: Prepared['kinds'] = new Map();
  const classes = new Map<
    string,
    { namingClass: NamingClass; mimeType: string }
  >();
  for (const f of kept) {
    const c = classify(f.file, cfg.conversion);
    if (c.kind === 'skip') continue;
    kinds.set(f.file.id, { kind: c.kind, namingClass: c.namingClass });
    classes.set(f.file.id, {
      namingClass: c.namingClass,
      mimeType: f.file.mimeType,
    });
  }

  const { paths, shareDirs } = layout(
    kept,
    snapshot.shares,
    classes,
    cfg.naming,
  );

  const items: PlanItem[] = kept.map((f) => {
    const k = kinds.get(f.file.id);
    let preSkip: SkipReason | null = null;
    let desiredPath = paths.get(f.file.id) ?? null;
    if (!k) preSkip = 'non-convertible';
    else if (
      k.namingClass !== 'google-native' &&
      Number(f.file.size ?? 0) > cfg.maxFileBytes
    ) {
      preSkip = 'oversize';
    } else if (
      desiredPath &&
      Buffer.byteLength(path.join(targetDir, desiredPath), 'utf8') >
        cfg.naming.maxPathBytes
    ) {
      preSkip = 'path-too-long';
      desiredPath = null;
    }
    return {
      id: f.file.id,
      modifiedTime: f.file.modifiedTime ?? null,
      kind: k?.kind ?? null,
      desiredPath: preSkip ? null : desiredPath,
      preSkip,
      probeKey: probeKey(
        f.file,
        k?.namingClass ?? null,
        ledger.get(f.file.id),
        client,
      ),
      pathResolved: f.pathResolved,
      shareIds: f.shareIds,
    };
  });

  return {
    items,
    files: new Map(kept.map((f) => [f.file.id, f])),
    kinds,
    shareDirs,
    excluded: snapshot.files.length - kept.length,
  };
}
