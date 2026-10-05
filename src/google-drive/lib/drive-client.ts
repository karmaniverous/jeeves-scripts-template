/**
 * @module google-drive/lib/drive-client
 *
 * Thin, read-only gog wrappers for the Drive and Sheets calls the sync
 * makes (spec §4, §5). Every invocation goes through `buildGogArgs`,
 * which hard-codes `--readonly`: gog's tokens carry the FULL `drive`
 * and `spreadsheets` scopes and sharers routinely grant the account
 * Editor, so `--readonly` is the only write guard (spec §9, §11).
 *
 * The `GogExec` seam is injectable so the domain is testable without
 * spawning gog.
 */

import { gogWithRetry } from '../../lib/gog.js';
import {
  DownloadResultSchema,
  type DriveFile,
  DriveFileSchema,
  DriveListSchema,
  FileListSchema,
  RevisionListSchema,
  SheetMetadataSchema,
  SheetValuesSchema,
} from './types.js';

/** Executes gog with fully-built args, returning stdout. */
export type GogExec = (args: string[]) => string;

/** Fields requested for every listed file (keeps list calls cheap). */
const FILE_FIELDS =
  'id,name,mimeType,parents,driveId,owners(emailAddress),sharingUser(emailAddress),' +
  'modifiedTime,md5Checksum,size,trashed,capabilities(canReadRevisions)';
const LIST_FIELDS = `nextPageToken,files(${FILE_FIELDS})`;
const PAGE_SIZE = '1000';

/** Parent ids per batched `'<id>' in parents or …` query (spec §4.4). */
export const PARENT_BATCH = 25;

/** Prefix every gog call with the read-only guard and the account. */
export function buildGogArgs(account: string, args: string[]): string[] {
  return ['--readonly', '--no-input', '--account', account, ...args];
}

/** The Drive/Sheets surface the sync uses. */
export interface DriveClient {
  readonly account: string;
  listSharedWithMe(): DriveFile[];
  listChildren(parentIds: string[]): DriveFile[];
  getFile(id: string, asAccount?: string): DriveFile;
  listDriveNames(asAccount: string): Map<string, string>;
  latestRevisionId(id: string): string | null;
  /** Export a Google-native file; returns the path gog actually wrote (it swaps the extension). */
  exportTo(id: string, format: 'md' | 'txt', outPath: string): string;
  /** Download a blob; returns the path gog actually wrote. */
  downloadTo(id: string, outPath: string): string;
  sheetTabs(id: string): string[];
  sheetValues(id: string, tab: string): unknown[][];
}

/** Quote a sheet title for an A1 range (`'It''s'`). */
export function quoteSheetTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

/** Build a gog-backed DriveClient for `account`. */
export function createDriveClient(
  account: string,
  exec: GogExec = (args) => gogWithRetry(args),
): DriveClient {
  const run = (args: string[], as = account): string =>
    exec(buildGogArgs(as, args));
  const json = (args: string[], as?: string): unknown =>
    JSON.parse(run([...args, '--json'], as));

  /** Follow `nextPageToken` until exhausted, yielding each parsed page. */
  function* pages<T extends { nextPageToken?: string }>(
    args: string[],
    schema: { parse: (v: unknown) => T },
    as?: string,
  ): Generator<T> {
    let page: string | undefined;
    do {
      const parsed = schema.parse(
        json(page ? [...args, '--page', page] : args, as),
      );
      yield parsed;
      page = parsed.nextPageToken || undefined;
    } while (page);
  }

  const listAll = (query: string): DriveFile[] => {
    const args = [
      'drive',
      'ls',
      '--all',
      '--query',
      query,
      '--fields',
      LIST_FIELDS,
      '--max',
      PAGE_SIZE,
    ];
    return [...pages(args, FileListSchema)].flatMap((p) => p.files);
  };

  return {
    account,
    listSharedWithMe: () => listAll('sharedWithMe and trashed=false'),
    listChildren: (parentIds) => {
      const out: DriveFile[] = [];
      for (let i = 0; i < parentIds.length; i += PARENT_BATCH) {
        const chunk = parentIds.slice(i, i + PARENT_BATCH);
        const clause = chunk.map((id) => `'${id}' in parents`).join(' or ');
        out.push(...listAll(`(${clause}) and trashed=false`));
      }
      return out;
    },
    getFile: (id, asAccount) =>
      DriveFileSchema.parse(
        JSON.parse(
          run(
            [
              'drive',
              'raw',
              id,
              '--fields',
              'id,name,mimeType,parents,driveId',
            ],
            asAccount,
          ),
        ),
      ),
    listDriveNames: (asAccount) => {
      const names = new Map<string, string>();
      for (const p of pages(
        ['drive', 'drives', '--max', '100'],
        DriveListSchema,
        asAccount,
      )) {
        for (const d of p.drives) names.set(d.id, d.name);
      }
      return names;
    },
    latestRevisionId: (id) => {
      const args = ['drive', 'revisions', 'list', id, '--max', '200'];
      args.push('--fields', 'nextPageToken,revisions(id,modifiedTime)');
      let last: string | null = null;
      for (const p of pages(args, RevisionListSchema))
        last = p.revisions.at(-1)?.id ?? last;
      return last;
    },
    exportTo: (id, format, outPath) =>
      DownloadResultSchema.parse(
        json([
          'drive',
          'download',
          id,
          '--format',
          format,
          '--out',
          outPath,
          '--overwrite',
        ]),
      ).path,
    downloadTo: (id, outPath) =>
      DownloadResultSchema.parse(
        json(['drive', 'download', id, '--out', outPath, '--overwrite']),
      ).path,
    sheetTabs: (id) =>
      SheetMetadataSchema.parse(json(['sheets', 'metadata', id])).sheets.map(
        (s) => s.properties.title,
      ),
    sheetValues: (id, tab) =>
      SheetValuesSchema.parse(json(['sheets', 'get', id, quoteSheetTitle(tab)]))
        .values,
  };
}
