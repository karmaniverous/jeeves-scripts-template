import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  it('renders every worksheet as a table (dates, booleans, rich text, cached formula results)', async () => {
    // fixtures/sample.xlsx: Users (4 rows, incl. a Date, booleans, a
    // rich-text cell and a formula with a cached result) and an empty sheet.
    const buf = fs.readFileSync(
      path.join(import.meta.dirname, 'fixtures', 'sample.xlsx'),
    );
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
      [
        '## Users',
        '',
        '| Name | Age | Joined | Active |',
        '| --- | --- | --- | --- |',
        '| Ada | 36 | 2026-01-02T00:00:00.000Z | true |',
        '| Pipe \\| name |  |  | false |',
        '| Rich text | 72 |  |  |',
        '',
        '## Empty',
        '',
        '_(empty)_',
      ].join('\n'),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
