/**
 * @module google-drive/lib/fake-drive.test-helper
 *
 * In-memory DriveClient for unit tests. `as` views let tests model what
 * each account can see (e.g. the sync account sees no `parents` on
 * shared items; the owner sees the whole chain).
 */

import type { DriveClient } from './drive-client.js';
import type { DriveFile } from './types.js';

export interface FakeDriveSpec {
  account?: string;
  sharedWithMe?: DriveFile[];
  /** Items visible to the sync account when listing children. */
  children?: DriveFile[];
  /** Per-impersonated-account file views, keyed `account|id`. */
  views?: Record<string, DriveFile>;
  driveNames?: Record<string, Record<string, string>>;
  revisions?: Record<string, string>;
}

export function file(partial: Partial<DriveFile> & { id: string }): DriveFile {
  return { name: partial.id, mimeType: 'text/plain', ...partial };
}

export function fakeDrive(
  spec: FakeDriveSpec,
): DriveClient & { calls: string[] } {
  const calls: string[] = [];
  const account = spec.account ?? 'assistant@example.com';
  return {
    account,
    calls,
    listSharedWithMe: () => {
      calls.push('sharedWithMe');
      return spec.sharedWithMe ?? [];
    },
    listChildren: (parentIds) => {
      calls.push(`children:${parentIds.join(',')}`);
      return (spec.children ?? []).filter((c) =>
        parentIds.includes(c.parents?.[0] ?? ''),
      );
    },
    getFile: (id, asAccount) => {
      const key = `${asAccount ?? account}|${id}`;
      calls.push(`get:${key}`);
      const found = spec.views?.[key];
      if (!found) throw new Error(`404 ${key}`);
      return found;
    },
    listDriveNames: (asAccount) => {
      calls.push(`drives:${asAccount}`);
      return new Map(Object.entries(spec.driveNames?.[asAccount] ?? {}));
    },
    latestRevisionId: (id) => {
      calls.push(`rev:${id}`);
      return spec.revisions?.[id] ?? null;
    },
    exportTo: () => {
      throw new Error('fake: exportTo not implemented');
    },
    downloadTo: () => {
      throw new Error('fake: downloadTo not implemented');
    },
    sheetTabs: () => [],
    sheetValues: () => [],
  };
}
