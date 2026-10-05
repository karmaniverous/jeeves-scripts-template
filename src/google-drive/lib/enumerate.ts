/**
 * @module google-drive/lib/enumerate
 *
 * Build the remote snapshot (spec §4.4), metadata only, as the sync
 * account:
 * 1. `sharedWithMe` lists every item shared to the account (Q5).
 * 2. Each share is located (resolve-path.ts).
 * 3. Shared folders are walked breadth-first, with children of many
 *    folders fetched per call (batched parent queries).
 * 4. Items reachable more than once are kept once, at their best
 *    placement: a resolved path beats an unresolved one, then the longer
 *    (fuller) visible path wins (spec §4.3 "highest visible ancestor").
 */

import type { DriveClient } from './drive-client.js';
import type { PathResolver } from './resolve-path.js';
import type {
  DriveFile,
  PathSegment,
  RootInfo,
  Share,
  SnapshotFile,
} from './types.js';
import { FOLDER_MIME } from './types.js';

const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

interface Placement {
  root: RootInfo;
  ancestors: PathSegment[];
  pathResolved: boolean;
}

export interface Snapshot {
  shares: Share[];
  files: SnapshotFile[];
  /** Non-fatal enumeration problems (e.g. a folder listing failed). */
  errors: string[];
}

/** True when `a` is a better placement than `b` (see module doc). */
export function betterPlacement(a: Placement, b: Placement): boolean {
  if (a.pathResolved !== b.pathResolved) return a.pathResolved;
  return a.ancestors.length > b.ancestors.length;
}

interface Node {
  file: DriveFile;
  best: Placement;
  shareIds: Set<string>;
}

function offer(
  nodes: Map<string, Node>,
  file: DriveFile,
  p: Placement,
  shareId: string,
): void {
  const node = nodes.get(file.id);
  if (!node) {
    nodes.set(file.id, { file, best: p, shareIds: new Set([shareId]) });
    return;
  }
  node.shareIds.add(shareId);
  if (betterPlacement(p, node.best)) node.best = p;
}

/** Walk one shared folder's subtree, offering every descendant. */
function walkFolder(
  client: DriveClient,
  share: Share,
  folder: DriveFile,
  nodes: Map<string, Node>,
  errors: string[],
): void {
  const visited = new Set<string>([folder.id]);
  const start = share.isDriveRoot
    ? []
    : [...share.ancestors, { id: folder.id, name: folder.name }];
  let frontier = new Map<string, PathSegment[]>([[folder.id, start]]);
  while (frontier.size > 0) {
    let children: DriveFile[];
    try {
      children = client.listChildren([...frontier.keys()]);
    } catch (err) {
      errors.push(`list children of share ${share.id}: ${String(err)}`);
      return;
    }
    const next = new Map<string, PathSegment[]>();
    for (const child of children) {
      if (child.trashed || child.mimeType === SHORTCUT_MIME) continue;
      const parentPath = frontier.get(child.parents?.[0] ?? '');
      if (!parentPath || visited.has(child.id)) continue;
      visited.add(child.id);
      const placement = {
        root: share.root,
        ancestors: parentPath,
        pathResolved: share.pathResolved,
      };
      offer(nodes, child, placement, share.id);
      if (child.mimeType === FOLDER_MIME) {
        next.set(child.id, [...parentPath, { id: child.id, name: child.name }]);
      }
    }
    frontier = next;
  }
}

/** Enumerate everything shared to the client's account. Throws if `sharedWithMe` fails. */
export function enumerate(
  client: DriveClient,
  resolver: PathResolver,
): Snapshot {
  const errors: string[] = [];
  const shared = client
    .listSharedWithMe()
    .filter((f) => !f.trashed && f.mimeType !== SHORTCUT_MIME);

  const shares: Share[] = [];
  for (const item of shared) {
    try {
      shares.push(resolver.resolveShare(item));
    } catch (err) {
      errors.push(`resolve share ${item.id}: ${String(err)}`);
    }
  }

  // Shared drives the account is a member of: membership is how a whole
  // drive is shared, so each one is a share rooted at the drive (§4.4).
  const memberDrives: DriveFile[] = [];
  try {
    for (const [id, name] of client.listDriveNames(client.account)) {
      shares.push({
        id,
        name,
        isFolder: true,
        isDriveRoot: true,
        root: { kind: 'drive', label: name, driveId: id },
        ancestors: [],
        pathResolved: true,
      });
      memberDrives.push({ id, name, mimeType: FOLDER_MIME });
    }
  } catch (err) {
    errors.push(`list member drives: ${String(err)}`);
  }

  const nodes = new Map<string, Node>();
  const byId = new Map([...shared, ...memberDrives].map((f) => [f.id, f]));
  for (const share of shares) {
    const item = byId.get(share.id);
    if (!item) continue;
    if (share.isDriveRoot) {
      walkFolder(client, share, item, nodes, errors);
      continue;
    }
    offer(nodes, item, share, share.id);
    if (share.isFolder) walkFolder(client, share, item, nodes, errors);
  }

  // A share's own location is its best placement (an inner share reached
  // through an outer shared folder sits inside it, spec §4.3).
  for (const share of shares) {
    const node = nodes.get(share.id);
    if (node) Object.assign(share, node.best);
  }

  const files: SnapshotFile[] = [];
  for (const node of nodes.values()) {
    if (node.file.mimeType === FOLDER_MIME) continue;
    files.push({
      file: node.file,
      ...node.best,
      shareIds: [...node.shareIds].sort(),
    });
  }
  return { shares, files, errors };
}
