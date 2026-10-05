/**
 * @module google-drive/lib/resolve-path
 *
 * Recover where a shared item lives (spec §4.2, §4.3). The sync account
 * can't see the parents of items shared to it, so the folder chain is
 * walked by impersonating someone who can, via domain-wide delegation:
 * the owner for My Drive items, the sharer for shared-drive items.
 * Calls are metadata-only and cached per run.
 *
 * Root handling (spike-confirmed): a My Drive walk ends at a folder
 * literally named `My Drive`, which is dropped (the identity root
 * replaces it). A shared drive's root folder is named `Drive` for every
 * drive, so the drive's real name comes from `drives.list`, never from
 * the root folder.
 */

import type { PathResolutionConfig } from './config.js';
import type { DriveClient } from './drive-client.js';
import type { DriveFile, PathSegment, RootInfo, Share } from './types.js';
import { FOLDER_MIME } from './types.js';

/** Upper bound on folder depth, guarding against cycles. */
const MAX_DEPTH = 100;

/** Identity used when no owner or sharer email is visible (spec §4.3). */
export const UNKNOWN_OWNER = 'unknown-owner';

export interface PathResolver {
  resolveShare(item: DriveFile): Share;
}

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

/** Create a resolver with per-run caches. */
export function createPathResolver(
  client: DriveClient,
  opts: PathResolutionConfig,
): PathResolver {
  const files = new Map<string, DriveFile>();
  const driveNames = new Map<string, Map<string, string>>();
  const domains = new Set(opts.domains.map((d) => d.toLowerCase()));
  const delegated = (email: string | undefined): email is string =>
    email !== undefined && domains.has(domainOf(email));

  const getAs = (id: string, as: string): DriveFile => {
    const key = `${as}|${id}`;
    let file = files.get(key);
    if (!file) {
      file = client.getFile(id, as);
      files.set(key, file);
    }
    return file;
  };

  const namesFor = (as: string): Map<string, string> => {
    let names = driveNames.get(as);
    if (!names) {
      names = client.listDriveNames(as);
      driveNames.set(as, names);
    }
    return names;
  };

  /** Folders between the root and `itemId`, root excluded. */
  const walk = (
    itemId: string,
    as: string,
    driveId?: string,
  ): PathSegment[] => {
    const segments: PathSegment[] = [];
    let parentId = getAs(itemId, as).parents?.[0];
    for (let depth = 0; parentId && depth < MAX_DEPTH; depth++) {
      if (driveId && parentId === driveId) break;
      const parent = getAs(parentId, as);
      const next = parent.parents?.[0];
      if (!next) break; // My Drive root: dropped.
      segments.unshift({ id: parent.id, name: parent.name });
      parentId = next;
    }
    return segments;
  };

  const tryWalk = (
    item: DriveFile,
    as: string | null,
    driveId?: string,
  ): { ancestors: PathSegment[]; pathResolved: boolean } => {
    if (!opts.impersonate || !as) return { ancestors: [], pathResolved: false };
    try {
      return { ancestors: walk(item.id, as, driveId), pathResolved: true };
    } catch {
      return { ancestors: [], pathResolved: false };
    }
  };

  return {
    resolveShare: (item) => {
      const isFolder = item.mimeType === FOLDER_MIME;
      const sharer = item.sharingUser?.emailAddress?.toLowerCase();

      if (item.driveId) {
        const as = delegated(sharer)
          ? sharer
          : opts.sharedDriveFallbackIdentity;
        let label: string | null = null;
        if (opts.impersonate && as) {
          try {
            label = namesFor(as).get(item.driveId) ?? null;
          } catch {
            label = null;
          }
        }
        const root: RootInfo = { kind: 'drive', label, driveId: item.driveId };
        const { ancestors, pathResolved } = tryWalk(item, as, item.driveId);
        return {
          id: item.id,
          name: item.name,
          isFolder,
          root,
          ancestors,
          pathResolved,
        };
      }

      const owner = item.owners?.[0]?.emailAddress?.toLowerCase();
      const identity = owner ?? sharer ?? UNKNOWN_OWNER;
      const root: RootInfo = { kind: 'identity', label: identity };
      const { ancestors, pathResolved } = tryWalk(
        item,
        delegated(owner) ? owner : null,
      );
      return {
        id: item.id,
        name: item.name,
        isFolder,
        root,
        ancestors,
        pathResolved,
      };
    },
  };
}
