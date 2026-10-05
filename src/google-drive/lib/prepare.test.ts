import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import { SheetsConversionSchema, SyncEntrySchema } from './config.js';
import { materialize } from './convert.js';
import { fakeDrive, file } from './fake-drive.test-helper.js';
import { excludePath, prepare } from './prepare.js';
import type { DriveFile, SnapshotFile } from './types.js';

const at = (f: DriveFile, folders: string[] = []): SnapshotFile => ({
  file: f,
  root: { kind: 'identity', label: 'o@example.com' },
  ancestors: folders.map((name) => ({ id: `id-${name}`, name })),
  pathResolved: true,
  shareIds: ['s'],
});

describe('prepare (§3, §5, §8)', () => {
  const snapshot = {
    shares: [],
    errors: [],
    files: [
      at(file({ id: 'keep', name: 'a.txt', md5Checksum: 'k' }), ['docs']),
      at(file({ id: 'lock', name: 'x.lock' }), ['docs']),
      at(
        file({
          id: 'big',
          name: 'big.pdf',
          mimeType: 'application/pdf',
          size: '999999999',
        }),
      ),
      at(file({ id: 'img', name: 'p.png', mimeType: 'image/png' })),
      at(
        file({
          id: 'gdoc',
          name: 'G/D',
          mimeType: 'application/vnd.google-apps.document',
          size: '1024',
        }),
      ),
    ],
  };

  it('excludes by sanitized Drive path, classifies, and applies pre-download skips', () => {
    const cfg = SyncEntrySchema.parse({
      account: 'a@example.com',
      exclude: ['**/*.lock'],
    });
    const out = prepare(
      snapshot,
      new Map(),
      fakeDrive({}),
      cfg,
      '/c/google-drive',
    );
    expect(out.excluded).toBe(1);
    const byId = new Map(out.items.map((i) => [i.id, i]));
    expect(byId.has('lock')).toBe(false);
    expect(byId.get('keep')).toMatchObject({
      preSkip: null,
      probeKey: 'md5:k',
    });
    expect(byId.get('keep')?.desiredPath).toMatch(
      /^o@example\.com\/docs - [a-z2-7]{8}\/a - [a-z2-7]{8}\.txt$/,
    );
    expect(byId.get('big')).toMatchObject({
      preSkip: 'oversize',
      desiredPath: null,
    });
    expect(byId.get('img')).toMatchObject({
      preSkip: 'non-convertible',
      kind: null,
    });
    // Google-native `size` is a placeholder and never triggers oversize.
    expect(byId.get('gdoc')).toMatchObject({ preSkip: null, kind: 'gdoc' });
  });

  it('skips items whose absolute path would exceed maxPathBytes', () => {
    const cfg = SyncEntrySchema.parse({
      account: 'a@example.com',
      naming: { maxPathBytes: 40 },
    });
    const out = prepare(
      snapshot,
      new Map(),
      fakeDrive({}),
      cfg,
      '/c/google-drive',
    );
    expect(out.items.find((i) => i.id === 'keep')).toMatchObject({
      preSkip: 'path-too-long',
      desiredPath: null,
    });
  });

  it('builds exclude paths from sanitized segments (a "/" in a name becomes "_")', () => {
    expect(excludePath(at(file({ id: 'g', name: 'G/D' }), ['2026/10']))).toBe(
      'o@example.com/2026_10/G_D',
    );
  });
});

describe('xlsx conversion', () => {
  it('renders every worksheet as a table', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Users').addRows([
      ['Name', 'Age'],
      ['Ada', 36],
    ]);
    wb.addWorksheet('Empty');
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdrive-xlsx-'));
    const client = fakeDrive({});
    client.downloadTo = (_id, out) => {
      fs.writeFileSync(out, buf);
      return out;
    };
    const body = await materialize(
      'xlsx',
      file({ id: 'x' }),
      client,
      path.join(dir, 'x.dl'),
      SheetsConversionSchema.parse({}),
    );
    expect(body).toBe(
      '## Users\n\n| Name | Age |\n| --- | --- |\n| Ada | 36 |\n\n## Empty\n\n_(empty)_',
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
