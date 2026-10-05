import { describe, expect, it } from 'vitest';

import { classify } from './classify.js';
import { ConversionConfigSchema } from './config.js';
import { probeKey, writtenKey } from './content-key.js';
import { fakeDrive, file } from './fake-drive.test-helper.js';
import { emptyRecord } from './ledger.js';
import { lastExtension } from './naming.js';
import { cellText, renderTable, renderWorkbook } from './sheets-md.js';

const conv = ConversionConfigSchema.parse({});
const kindOf = (mimeType: string, name = 'x'): string =>
  classify(file({ id: '1', name, mimeType }), conv).kind;

describe('classify (§5)', () => {
  it('maps Google-native types and skips the rest of google-apps', () => {
    expect(kindOf('application/vnd.google-apps.document')).toBe('gdoc');
    expect(kindOf('application/vnd.google-apps.spreadsheet')).toBe('gsheet');
    expect(kindOf('application/vnd.google-apps.presentation')).toBe('gslides');
    expect(kindOf('application/vnd.google-apps.form')).toBe('skip');
    expect(kindOf('application/vnd.google-apps.drawing')).toBe('skip');
  });

  it('maps binaries by MIME, then by extension', () => {
    expect(kindOf('application/pdf')).toBe('pdf');
    expect(kindOf('application/octet-stream', 'report.DOCX')).toBe('docx');
    expect(kindOf('application/octet-stream', 'book.xlsx')).toBe('xlsx');
    expect(kindOf('application/octet-stream', 'deck.pptx')).toBe('office');
    expect(kindOf('text/rtf', 'a.rtf')).toBe('office');
  });

  it('recognises text by MIME, then extension; skips images', () => {
    expect(kindOf('text/markdown', 'a.md')).toBe('text');
    expect(kindOf('application/json', 'a.json')).toBe('text');
    expect(kindOf('application/octet-stream', 'main.py')).toBe('text');
    expect(kindOf('image/png', 'a.png')).toBe('skip');
  });

  it('honours config extensions and skip lists', () => {
    const custom = ConversionConfigSchema.parse({
      textExtensions: ['.foo'],
      skipMimeTypes: ['application/pdf'],
    });
    expect(
      classify(
        file({ id: '1', name: 'a.foo', mimeType: 'application/octet-stream' }),
        custom,
      ).kind,
    ).toBe('text');
    expect(
      classify(
        file({ id: '1', name: 'a.pdf', mimeType: 'application/pdf' }),
        custom,
      ).kind,
    ).toBe('skip');
  });

  it('only treats short alphanumeric suffixes as extensions', () => {
    expect(lastExtension('Notes v3.5 final')).toBe('');
    expect(lastExtension('report.final.docx')).toBe('.docx');
  });
});

describe('content keys (§6.2, two-stage)', () => {
  const gdoc = file({
    id: 'd',
    mimeType: 'application/vnd.google-apps.document',
    modifiedTime: 't2',
  });
  const prior = {
    ...emptyRecord(),
    written: { contentKey: 'rev:7', modifiedTime: 't1', kind: 'gdoc', at: 'x' },
  };

  it('uses md5 for blobs', () => {
    expect(
      probeKey(
        file({ id: 'b', md5Checksum: 'abc' }),
        'native-text',
        undefined,
        fakeDrive({}),
      ),
    ).toBe('md5:abc');
  });

  it('reuses the stored key when modifiedTime is unchanged (no call)', () => {
    const client = fakeDrive({});
    const same = { ...gdoc, modifiedTime: 't1' };
    expect(probeKey(same, 'google-native', prior, client)).toBe('rev:7');
    expect(client.calls).toEqual([]);
  });

  it('checks the revision when modifiedTime moved (rename keeps rev)', () => {
    expect(
      probeKey(
        gdoc,
        'google-native',
        prior,
        fakeDrive({ revisions: { d: '7' } }),
      ),
    ).toBe('rev:7');
    expect(
      probeKey(
        gdoc,
        'google-native',
        prior,
        fakeDrive({ revisions: { d: '8' } }),
      ),
    ).toBe('rev:8');
  });

  it('falls back to modifiedTime when revisions are unreadable', () => {
    const noRev = { ...gdoc, capabilities: { canReadRevisions: false } };
    expect(probeKey(noRev, 'google-native', prior, fakeDrive({}))).toBe(
      'mt:t2',
    );
    expect(writtenKey(noRev, 'google-native', fakeDrive({}))).toBe('mt:t2');
  });
});

describe('sheets-md', () => {
  const caps = { maxRowsPerTab: 2, maxCellChars: 5 };

  it('pads ragged rows, escapes pipes, clips cells and rows', () => {
    const md = renderTable(
      [['h1', 'h2'], ['a|b'], ['toolongvalue', 'x'], ['r3']],
      caps,
    );
    expect(md).toContain('| h1 | h2 |');
    expect(md).toContain('| a\\|b |  |');
    expect(md).toContain('toolo…');
    expect(md).toContain('1 more rows truncated');
  });

  it('renders empty tabs and workbooks', () => {
    expect(renderTable([[], ['']], caps)).toBe('_(empty)_');
    expect(renderWorkbook([], caps)).toBe('_(no tabs)_');
    expect(renderWorkbook([{ title: 'T', rows: [['a']] }], caps)).toMatch(
      /^## T\n\n\| a \|/,
    );
  });

  it('flattens exceljs cell shapes', () => {
    expect(cellText({ richText: [{ text: 'a' }, { text: 'b' }] })).toBe('ab');
    expect(cellText({ formula: 'x', result: 3 })).toBe('3');
    expect(cellText(null)).toBe('');
  });
});
