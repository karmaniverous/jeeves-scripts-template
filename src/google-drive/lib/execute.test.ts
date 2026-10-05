import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BudgetConfigSchema, SheetsConversionSchema } from './config.js';
import { decodeUtf8, materialize, SkipError } from './convert.js';
import type { DriveClient } from './drive-client.js';
import { backoffMs, type QueueContext, runQueue } from './execute.js';
import { fakeDrive, file } from './fake-drive.test-helper.js';
import { fakeRunner } from './fake-runner.test-helper.js';
import { createLedgerStore, emptyRecord } from './ledger.js';
import { item } from './plan.test-helper.js';
import type { SnapshotFile } from './types.js';

const sheets = SheetsConversionSchema.parse({});
let dir: string;
let staging: string;
let target: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdrive-exec-'));
  staging = path.join(dir, 'staging');
  target = path.join(dir, 'target');
  fs.mkdirSync(staging);
  fs.mkdirSync(target);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Downloads write `bodies[id]`; exports swap the extension like gog does. */
function client(bodies: Record<string, string | Buffer | Error>): DriveClient {
  const c = fakeDrive({});
  const write = (id: string, out: string): string => {
    const body = bodies[id];
    if (body instanceof Error) throw body;
    fs.writeFileSync(out, body);
    return out;
  };
  c.downloadTo = (id, out) => write(id, out);
  c.exportTo = (id, format, out) =>
    write(id, out.replace(/\.[^.]+$/, `.${format}`));
  c.sheetTabs = () => ['One', 'Two'];
  c.sheetValues = (_id, tab) => [['h'], [tab]];
  return c;
}

describe('materialize (§5)', () => {
  it('reads exports from the path gog reports and cleans staging', async () => {
    const c = client({ d: '# Doc' });
    const body = await materialize(
      'gdoc',
      file({ id: 'd' }),
      c,
      path.join(staging, '0.dl'),
      sheets,
    );
    expect(body).toBe('# Doc');
    expect(fs.readdirSync(staging)).toEqual([]);
  });

  it('renders every sheet tab', async () => {
    const body = await materialize(
      'gsheet',
      file({ id: 's' }),
      client({}),
      path.join(staging, 'x'),
      sheets,
    );
    expect(body).toContain('## One');
    expect(body).toContain('## Two');
  });

  it('keeps a UTF-8 BOM byte-for-byte', () => {
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    expect(Buffer.from(decodeUtf8(bytes, 'x'), 'utf8')).toEqual(bytes);
  });

  it('skips export-limit refusals and invalid UTF-8 permanently; other errors are retryable', async () => {
    const big = client({ d: new Error('exportSizeLimitExceeded') });
    await expect(
      materialize(
        'gdoc',
        file({ id: 'd' }),
        big,
        path.join(staging, 'x'),
        sheets,
      ),
    ).rejects.toBeInstanceOf(SkipError);
    expect(() => decodeUtf8(Buffer.from([0xff, 0xfe]), 'x')).toThrow(SkipError);
    const flaky = client({ d: new Error('network') });
    await expect(
      materialize(
        'gdoc',
        file({ id: 'd' }),
        flaky,
        path.join(staging, 'x'),
        sheets,
      ),
    ).rejects.not.toBeInstanceOf(SkipError);
  });
});

describe('runQueue (§6.4)', () => {
  const ids = ['a', 'b', 'c'];
  function ctx(
    bodies: Record<string, string | Buffer | Error>,
    over: Partial<QueueContext> = {},
  ): QueueContext {
    const files = new Map<string, SnapshotFile>(
      ids.map((id) => [
        id,
        {
          file: file({ id, md5Checksum: id }),
          root: { kind: 'identity', label: 'o@example.com' },
          ancestors: [],
          pathResolved: true,
          shareIds: [id],
        },
      ]),
    );
    return {
      queue: ids.map((id) => ({ id, isUpdate: false })),
      items: new Map(
        ids.map((id) => [
          id,
          item(id, `o/${id}.txt`, { probeKey: `md5:${id}` }),
        ]),
      ),
      files,
      kinds: new Map(
        ids.map((id) => [
          id,
          { kind: 'text' as const, namingClass: 'native-text' as const },
        ]),
      ),
      records: new Map(ids.map((id) => [id, emptyRecord()])),
      store: createLedgerStore(fakeRunner().client, 'x@example.com', true),
      client: client(bodies),
      targetDir: target,
      stagingDir: staging,
      budget: BudgetConfigSchema.parse({}),
      sheets,
      deadline: Date.now() + 60_000,
      shouldStop: () => false,
      now: () => new Date('2026-10-05T12:00:00Z'),
      ...over,
    };
  }

  it('writes native text byte-for-byte and records the content key', async () => {
    const c = ctx({ a: 'A', b: 'B', c: 'C' });
    expect(await runQueue(c)).toMatchObject({
      processed: 3,
      failed: 0,
      remaining: 0,
    });
    expect(fs.readFileSync(path.join(target, 'o/a.txt'), 'utf8')).toBe('A');
    expect(c.records.get('a')).toMatchObject({
      localPath: 'o/a.txt',
      written: { contentKey: 'md5:a' },
    });
    expect(fs.readdirSync(staging)).toEqual([]);
  });

  it('stops at the item budget or on SIGTERM, leaving the rest queued', async () => {
    const byItems = ctx(
      { a: 'A', b: 'B', c: 'C' },
      { budget: BudgetConfigSchema.parse({ maxItems: 2 }) },
    );
    expect(await runQueue(byItems)).toMatchObject({
      processed: 2,
      remaining: 1,
    });
    expect(await runQueue(ctx({}, { shouldStop: () => true }))).toMatchObject({
      processed: 0,
      remaining: 3,
    });
  });

  it('lets a signal handler run between items (SIGTERM is a macrotask)', async () => {
    let stop = false;
    setImmediate(() => {
      stop = true;
    });
    expect(
      await runQueue(
        ctx({ a: 'A', b: 'B', c: 'C' }, { shouldStop: () => stop }),
      ),
    ).toMatchObject({ processed: 0, remaining: 3 });
  });

  it('reads the content key before exporting, so a mid-export edit is caught next run', async () => {
    const c = ctx({});
    const native = file({
      id: 'a',
      mimeType: 'application/vnd.google-apps.document',
      modifiedTime: 't1',
    });
    c.files.set('a', { ...(c.files.get('a') as SnapshotFile), file: native });
    c.kinds.set('a', { kind: 'gdoc', namingClass: 'google-native' });
    c.queue = [{ id: 'a', isUpdate: false }];
    let rev = '7';
    c.client.latestRevisionId = () => rev;
    c.client.exportTo = (_id, format, out) => {
      rev = '8'; // edited while we export
      const p = out.replace(/\.[^.]+$/, `.${format}`);
      fs.writeFileSync(p, 'old body');
      return p;
    };
    await runQueue(c);
    expect(c.records.get('a')?.written?.contentKey).toBe('rev:7');
  });

  it('leaves an old copy for the guarded planner when an update becomes a permanent skip', async () => {
    fs.mkdirSync(path.join(target, 'o'));
    fs.writeFileSync(path.join(target, 'o/b.txt'), 'old');
    const c = ctx(
      { b: Buffer.from([0xff]) },
      { queue: [{ id: 'b', isUpdate: true }] },
    );
    c.records.set('b', { ...emptyRecord(), localPath: 'o/b.txt' });
    await runQueue(c);
    expect(fs.readFileSync(path.join(target, 'o/b.txt'), 'utf8')).toBe('old');
    expect(c.records.get('b')).toMatchObject({
      localPath: null,
      skipped: { reason: 'invalid-utf8' },
    });
  });

  it('records permanent skips, and backs off then parks on failures', async () => {
    const c = ctx({ a: 'A', b: Buffer.from([0xff]), c: new Error('boom') });
    c.records.set('c', { ...emptyRecord(), attempts: 4 });
    expect(await runQueue(c)).toMatchObject({
      processed: 1,
      skipped: 1,
      failed: 1,
    });
    expect(c.records.get('b')?.skipped).toEqual({
      reason: 'invalid-utf8',
      key: 'md5:b',
    });
    expect(c.records.get('c')).toMatchObject({
      attempts: 5,
      lastError: 'boom',
      parked: { key: 'md5:c' },
    });
  });

  it('backs off exponentially, capped at 6 h', () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(3)).toBe(240_000);
    expect(backoffMs(30)).toBe(6 * 3600_000);
  });
});
