/**
 * @module google-drive/lib/tree
 *
 * Lay the snapshot out as local paths (spec §3): identity roots are the
 * verbatim email; shared-drive roots, folders and files get
 * `<name> - <tag>` segments, with sibling tag collisions resolved per
 * parent directory (spec §3.1). Also derives each share's root and
 * share-point directories (spec §3, §7).
 *
 * Pure: all inputs come from the snapshot, so the layout is
 * deterministic from Drive state alone.
 */

import type { NamingConfig } from './config.js';
import {
  buildSegmentName,
  identityRootSegment,
  type NamingClass,
  resolveSiblingTags,
  splitStemExt,
} from './naming.js';
import type { PathSegment, RootInfo, Share, SnapshotFile } from './types.js';

export interface ShareDirs {
  shareId: string;
  rootDir: string;
  sharePointDir: string;
}

export interface Layout {
  /** fileId → path relative to targetDir. */
  paths: Map<string, string>;
  shareDirs: ShareDirs[];
}

const DRIVE_ROOTS = '<drive-roots>';

function rootKey(root: RootInfo): string {
  return root.kind === 'drive'
    ? `drive:${root.driveId ?? ''}`
    : `identity:${root.label ?? ''}`;
}

/** Registers parent → child relations and resolves tags lazily. */
class SiblingIndex {
  private readonly children = new Map<string, Set<string>>();
  private readonly resolved = new Map<string, Map<string, string>>();

  add(parentKey: string, childId: string): void {
    const set = this.children.get(parentKey) ?? new Set<string>();
    set.add(childId);
    this.children.set(parentKey, set);
  }

  tag(parentKey: string, childId: string): string {
    let tags = this.resolved.get(parentKey);
    if (!tags) {
      tags = resolveSiblingTags(
        [...(this.children.get(parentKey) ?? [])].sort(),
      );
      this.resolved.set(parentKey, tags);
    }
    const tag = tags.get(childId);
    if (!tag) throw new Error(`tree: no tag for ${childId} under ${parentKey}`);
    return tag;
  }
}

/**
 * Compute local paths for every snapshot file and the root/share-point
 * directories for every share.
 */
export function layout(
  files: SnapshotFile[],
  shares: Share[],
  classes: Map<string, { namingClass: NamingClass; mimeType: string }>,
  naming: NamingConfig,
): Layout {
  const index = new SiblingIndex();
  const opts = { maxNameBytes: naming.maxNameBytes };

  const registerChain = (root: RootInfo, ancestors: PathSegment[]): string => {
    let parent = rootKey(root);
    if (root.kind === 'drive') index.add(DRIVE_ROOTS, root.driveId ?? '');
    for (const seg of ancestors) {
      index.add(parent, seg.id);
      parent = `${parent}/${seg.id}`;
    }
    return parent;
  };

  for (const f of files)
    index.add(registerChain(f.root, f.ancestors), f.file.id);
  for (const s of shares) {
    const parent = registerChain(s.root, s.ancestors);
    if (s.isFolder && !s.isDriveRoot) index.add(parent, s.id);
  }

  const rootSegment = (root: RootInfo): string => {
    if (root.kind === 'identity')
      return identityRootSegment(root.label ?? 'unknown-owner');
    const driveId = root.driveId ?? '';
    return buildSegmentName(
      root.label ?? 'shared-drive',
      index.tag(DRIVE_ROOTS, driveId),
      '',
      opts,
    );
  };

  const dirOf = (root: RootInfo, ancestors: PathSegment[]): string[] => {
    const parts = [rootSegment(root)];
    let parent = rootKey(root);
    for (const seg of ancestors) {
      parts.push(
        buildSegmentName(seg.name, index.tag(parent, seg.id), '', opts),
      );
      parent = `${parent}/${seg.id}`;
    }
    return parts;
  };

  const parentKeyOf = (root: RootInfo, ancestors: PathSegment[]): string =>
    [rootKey(root), ...ancestors.map((a) => a.id)].join('/');

  const paths = new Map<string, string>();
  for (const f of files) {
    const cls = classes.get(f.file.id);
    if (!cls) continue;
    const { stem, ext } = splitStemExt(
      f.file.name,
      cls.namingClass,
      cls.mimeType,
    );
    const tag = index.tag(parentKeyOf(f.root, f.ancestors), f.file.id);
    const segment = buildSegmentName(stem, tag, ext, opts);
    paths.set(f.file.id, [...dirOf(f.root, f.ancestors), segment].join('/'));
  }

  const shareDirs: ShareDirs[] = shares.map((s) => {
    const dir = dirOf(s.root, s.ancestors);
    if (s.isFolder && !s.isDriveRoot) {
      const tag = index.tag(parentKeyOf(s.root, s.ancestors), s.id);
      dir.push(buildSegmentName(s.name, tag, '', opts));
    }
    return { shareId: s.id, rootDir: dir[0], sharePointDir: dir.join('/') };
  });

  return { paths, shareDirs };
}
