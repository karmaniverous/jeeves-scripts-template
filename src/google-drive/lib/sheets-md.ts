/**
 * @module google-drive/lib/sheets-md
 *
 * Render spreadsheet rows as Markdown tables (spec §5): one table per
 * tab, sized from the returned values (never from grid properties,
 * which report the default 1000×26 grid), with ragged rows padded to
 * the widest row, and with row and cell caps from config.
 */

import type { SheetsConversionConfig } from './config.js';

/** Plain text for one cell value (Sheets API or exceljs shapes). */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.richText)) {
      return v.richText
        .map((r: unknown) => cellText((r as Record<string, unknown>).text))
        .join('');
    }
    if ('result' in v) return cellText(v.result);
    if ('text' in v) return cellText(v.text);
    if ('error' in v) return cellText(v.error);
  }
  return '';
}

function escapeCell(text: string, maxChars: number): string {
  const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  return clipped
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');
}

/** Render rows (first row = header) as a Markdown table. */
export function renderTable(
  rows: unknown[][],
  caps: SheetsConversionConfig,
): string {
  const nonEmpty = rows.filter((r) => r.some((c) => cellText(c) !== ''));
  if (nonEmpty.length === 0) return '_(empty)_';

  const kept = nonEmpty.slice(0, caps.maxRowsPerTab + 1);
  const width = Math.max(...kept.map((r) => r.length));
  const line = (r: unknown[]): string => {
    const cells = Array.from({ length: width }, (_, i) =>
      escapeCell(cellText(r[i]), caps.maxCellChars),
    );
    return `| ${cells.join(' | ')} |`;
  };

  const [header, ...body] = kept;
  const out = [
    line(header),
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
  ];
  for (const r of body) out.push(line(r));
  const dropped = nonEmpty.length - kept.length;
  if (dropped > 0) out.push('', `_(${String(dropped)} more rows truncated)_`);
  return out.join('\n');
}

/** Render named tabs as `## <tab>` sections. */
export function renderWorkbook(
  tabs: { title: string; rows: unknown[][] }[],
  caps: SheetsConversionConfig,
): string {
  if (tabs.length === 0) return '_(no tabs)_';
  return tabs
    .map((t) => `## ${t.title}\n\n${renderTable(t.rows, caps)}`)
    .join('\n\n');
}
