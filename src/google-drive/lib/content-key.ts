/**
 * @module google-drive/lib/content-key
 *
 * Content keys for change detection (spec §6.2). Blobs use
 * `md5Checksum`. Google-native files have no checksum and their
 * `modifiedTime` moves on renames (spike §8), so they use a two-stage
 * check: unchanged `modifiedTime` → reuse the stored key (no call);
 * changed → fetch the latest revision id, which a rename does not
 * change. When revisions are unreadable, fall back to `modifiedTime`.
 */

import type { DriveClient } from './drive-client.js';
import type { LedgerRecord } from './ledger.js';
import type { NamingClass } from './naming.js';
import type { DriveFile } from './types.js';

const mtKey = (file: DriveFile): string => `mt:${file.modifiedTime ?? ''}`;

/** Blobs: md5 when Drive reports one, else modifiedTime. */
const blobKey = (file: DriveFile): string =>
  file.md5Checksum ? `md5:${file.md5Checksum}` : mtKey(file);

function revisionKey(file: DriveFile, client: DriveClient): string {
  if (file.capabilities?.canReadRevisions === false) return mtKey(file);
  try {
    const rev = client.latestRevisionId(file.id);
    return rev ? `rev:${rev}` : mtKey(file);
  } catch {
    return mtKey(file);
  }
}

/** The key to compare against the ledger this run. */
export function probeKey(
  file: DriveFile,
  namingClass: NamingClass | null,
  prior: LedgerRecord | undefined,
  client: DriveClient,
): string {
  if (namingClass !== 'google-native') return blobKey(file);
  const written = prior?.written;
  if (!written) return mtKey(file);
  if (written.modifiedTime === (file.modifiedTime ?? null))
    return written.contentKey;
  return revisionKey(file, client);
}

/** The key to store when a file is written. */
export function writtenKey(
  file: DriveFile,
  namingClass: NamingClass,
  client: DriveClient,
): string {
  return namingClass === 'google-native'
    ? revisionKey(file, client)
    : blobKey(file);
}
