/**
 * @module google-drive/lib/convert
 *
 * Materialise one Drive file as text (spec §5). Downloads land in the
 * staging directory (outside the content tree, spec §6.5); the caller
 * writes the returned text into place atomically.
 *
 * Permanent outcomes are signalled with `SkipError` (Drive export limit,
 * invalid UTF-8) so the item is skipped until its content changes,
 * rather than retried and parked.
 */

import { readFileSync, rmSync } from 'node:fs';

import ExcelJS from 'exceljs';
import { convert as officeConvert } from 'officeparser';
import { PDFParse } from 'pdf-parse';

import type { ConversionKind } from './classify.js';
import type { SheetsConversionConfig } from './config.js';
import type { DriveClient } from './drive-client.js';
import type { SkipReason } from './ledger.js';
import { renderWorkbook } from './sheets-md.js';
import type { DriveFile } from './types.js';

/** A permanent per-item outcome: skip until the content key changes. */
export class SkipError extends Error {
  constructor(
    readonly reason: SkipReason,
    message: string,
  ) {
    super(message);
    this.name = 'SkipError';
  }
}

/** Drive's export-size refusal (files.export caps exports at 10 MB). */
export function isExportLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /exportSizeLimitExceeded|too large to be exported/i.test(msg);
}

function exportOrSkip(
  client: DriveClient,
  file: DriveFile,
  format: 'md' | 'txt',
  out: string,
): string {
  try {
    return client.exportTo(file.id, format, out);
  } catch (err) {
    if (isExportLimitError(err)) {
      throw new SkipError(
        'export-limit',
        `export over Drive's 10 MB limit: ${file.name}`,
      );
    }
    throw err;
  }
}

/** Decode strictly as UTF-8, or skip. */
export function decodeUtf8(buf: Buffer, name: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      buf,
    );
  } catch {
    throw new SkipError('invalid-utf8', `not valid UTF-8: ${name}`);
  }
}

async function xlsxToMarkdown(
  file: string,
  caps: SheetsConversionConfig,
): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const tabs: { title: string; rows: unknown[][] }[] = [];
  wb.eachSheet((ws) => {
    const rows: unknown[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values = row.values as unknown[];
      rows.push(values.slice(1)); // exceljs rows are 1-indexed.
    });
    tabs.push({ title: ws.name, rows });
  });
  return renderWorkbook(tabs, caps);
}

async function pdfToText(file: string): Promise<string> {
  const parser = new PDFParse({ data: readFileSync(file) });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

/**
 * Produce the Markdown/text body for `file`. `stagingFile` is a scratch
 * path in the staging directory; it is removed before returning.
 */
export async function materialize(
  kind: ConversionKind,
  file: DriveFile,
  client: DriveClient,
  stagingFile: string,
  caps: SheetsConversionConfig,
): Promise<string> {
  // gog swaps the extension on exports, so track the paths it reports.
  const written: string[] = [stagingFile];
  const track = (p: string): string => {
    written.push(p);
    return p;
  };
  const blob = (): string => track(client.downloadTo(file.id, stagingFile));
  const exported = (format: 'md' | 'txt'): string =>
    track(exportOrSkip(client, file, format, stagingFile));
  try {
    switch (kind) {
      case 'gdoc':
        return readFileSync(exported('md'), 'utf8');
      case 'gslides':
        return readFileSync(exported('txt'), 'utf8');
      case 'gsheet': {
        const tabs = client.sheetTabs(file.id).map((title) => ({
          title,
          rows: client.sheetValues(file.id, title),
        }));
        return renderWorkbook(tabs, caps);
      }
      case 'text':
        return decodeUtf8(readFileSync(blob()), file.name);
      case 'pdf':
        return await pdfToText(blob());
      case 'xlsx':
        return await xlsxToMarkdown(blob(), caps);
      case 'docx':
      case 'office':
        return (await officeConvert(readFileSync(blob()), 'md')).value;
      default: {
        const unsupported: never = kind;
        throw new Error(`unsupported conversion kind: ${String(unsupported)}`);
      }
    }
  } finally {
    for (const p of written) rmSync(p, { force: true });
  }
}
