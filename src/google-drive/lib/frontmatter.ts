/**
 * @module google-drive/lib/frontmatter
 *
 * YAML frontmatter for Google-native exports and converted binaries
 * (spec §5). Native text files are written byte-for-byte with no
 * frontmatter, because it would corrupt code and config.
 */

import type { ConversionKind } from './classify.js';
import type { SnapshotFile } from './types.js';

/** Whether this kind of output carries frontmatter. */
export function wantsFrontmatter(kind: ConversionKind): boolean {
  return kind !== 'text';
}

/** An item's Drive path as segments: root label, folders, name (unsanitized). */
export function driveSegments(f: SnapshotFile): string[] {
  const root =
    f.root.label ??
    (f.root.kind === 'drive'
      ? `shared-drive ${f.root.driveId ?? ''}`
      : 'unknown');
  return [root, ...f.ancestors.map((a) => a.name), f.file.name];
}

/** The Drive path shown in frontmatter. */
export function drivePathOf(f: SnapshotFile): string {
  return driveSegments(f).join(' / ');
}

/** Prefix `body` with frontmatter describing `f`. JSON strings are valid YAML scalars. */
export function withFrontmatter(f: SnapshotFile, body: string): string {
  const fields: [string, string | boolean | undefined][] = [
    ['source', 'google-drive'],
    ['driveFileId', f.file.id],
    ['driveUrl', `https://drive.google.com/open?id=${f.file.id}`],
    ['mimeType', f.file.mimeType],
    ['owner', f.file.owners?.[0]?.emailAddress],
    ['sharedBy', f.file.sharingUser?.emailAddress],
    ['modifiedTime', f.file.modifiedTime],
    ['drivePath', drivePathOf(f)],
    ['pathResolved', f.pathResolved],
  ];
  const lines = fields
    .filter((e): e is [string, string | boolean] => e[1] !== undefined)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join('\n')}\n---\n\n${body.endsWith('\n') || body === '' ? body : `${body}\n`}`;
}
