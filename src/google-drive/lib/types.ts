/**
 * @module google-drive/lib/types
 *
 * Runtime schemas for the Drive API payloads the sync consumes (as
 * returned by `gog … --json`), plus the internal snapshot types the
 * planner works on. API payloads are validated with Zod at the
 * boundary (drive-client.ts) so the rest of the domain can trust them.
 */

import { z } from 'zod';

const EmailUserSchema = z.object({ emailAddress: z.string().optional() });

export const DriveFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  parents: z.array(z.string()).optional(),
  driveId: z.string().optional(),
  owners: z.array(EmailUserSchema).optional(),
  sharingUser: EmailUserSchema.optional(),
  modifiedTime: z.string().optional(),
  md5Checksum: z.string().optional(),
  size: z.string().optional(),
  trashed: z.boolean().optional(),
  capabilities: z
    .object({ canReadRevisions: z.boolean().optional() })
    .optional(),
});
export type DriveFile = z.infer<typeof DriveFileSchema>;

export const FileListSchema = z.object({
  files: z.array(DriveFileSchema).default([]),
  nextPageToken: z.string().optional(),
});

export const DriveListSchema = z.object({
  drives: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  nextPageToken: z.string().optional(),
});

/** `gog drive download --json` result; `path` is where gog actually wrote. */
export const DownloadResultSchema = z.object({ path: z.string() });

export const RevisionListSchema = z.object({
  revisions: z
    .array(z.object({ id: z.string(), modifiedTime: z.string().optional() }))
    .default([]),
  nextPageToken: z.string().optional(),
});

export const SheetMetadataSchema = z.object({
  sheets: z
    .array(z.object({ properties: z.object({ title: z.string() }) }))
    .default([]),
});

export const SheetValuesSchema = z.object({
  values: z.array(z.array(z.unknown())).default([]),
});

/** Drive folder MIME type. */
export const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** The ultimate Drive root an item lives under (spec §3, §4.3). */
export interface RootInfo {
  kind: 'identity' | 'drive';
  /** Email (identity) or drive name (drive); `null` drive name = unreadable. */
  label: string | null;
  /** Shared-drive id for `kind: 'drive'`. */
  driveId?: string;
}

/** A folder segment on an item's Drive path, root excluded. */
export interface PathSegment {
  id: string;
  name: string;
}

/** A share: an item shared to the account (spec §4.4). */
export interface Share {
  id: string;
  /** The shared item's Drive name. */
  name: string;
  isFolder: boolean;
  /** A shared drive the account is a member of: the whole drive is the share. */
  isDriveRoot?: boolean;
  root: RootInfo;
  /** Folders between the root and the shared item (root excluded). */
  ancestors: PathSegment[];
  pathResolved: boolean;
}

/** One file in the remote snapshot, with its resolved Drive location. */
export interface SnapshotFile {
  file: DriveFile;
  root: RootInfo;
  /** Folders from the root down to the file's parent (root excluded). */
  ancestors: PathSegment[];
  pathResolved: boolean;
  /** Ids of the shares that make this file reachable. */
  shareIds: string[];
}
