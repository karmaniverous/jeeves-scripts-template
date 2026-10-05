import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BudgetConfigSchema, SyncEntrySchema } from './config.js';
import type { DriveClient } from './drive-client.js';
import { createRunBudget } from './execute.js';
import { fakeDrive, file } from './fake-drive.test-helper.js';
import { fakeRunner } from './fake-runner.test-helper.js';
import type { RunnerState } from './ledger.js';
import type { FetchLike } from './meta-seed.js';
import { stagingDirFor, syncOne, type SyncOptions } from './run-sync.js';
import { FOLDER_MIME } from './types.js';

const cfg = SyncEntrySchema.parse({
  account: 'assistant@example.com',
  pathResolution: { domains: ['example.com'] },
});
const ext = {
  owners: [{ emailAddress: 'ext@example.org' }],
  sharingUser: { emailAddress: 'ext@example.org' },
};
const folder = file({
  id: 'F',
  name: 'Project',
  mimeType: FOLDER_MIME,
  ...ext,
});
const note = file({
  id: 'n',
  name: 'notes.txt',
  parents: ['F'],
  md5Checksum: 'v1',
});

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdrive-sync-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function drive(shared: boolean, body = 'hello'): DriveClient {
  const c = fakeDrive(
    shared ? { sharedWithMe: [folder], children: [note] } : {},
  );
  c.downloadTo = (_id, out) => {
    fs.writeFileSync(out, body);
    return out;
  };
  return c;
}

/** The meta service, simulated: creates `.meta/` and answers 201. */
const seedFetch: FetchLike = (_url, init) => {
  const body: unknown =
    typeof init.body === 'string' ? JSON.parse(init.body) : null;
  const p =
    body !== null &&
    typeof body === 'object' &&
    'path' in body &&
    typeof body.path === 'string'
      ? body.path
      : null;
  if (p === null) return Promise.resolve(new Response('', { status: 400 }));
  fs.mkdirSync(path.join(p, '.meta'), { recursive: true });
  return Promise.resolve(new Response('', { status: 201 }));
};

function opts(
  client: DriveClient,
  live: boolean,
  log: string[] = [],
): SyncOptions {
  return {
    live,
    allowMassDelete: false,
    budget: createRunBudget(BudgetConfigSchema.parse({}), Date.now()),
    shouldStop: () => false,
    log: (l) => log.push(l),
    client,
    contentDir: path.join(dir, 'content'),
    stagingRoot: path.join(dir, 'staging'),
    fetchFn: seedFetch,
  };
}

const target = (): string => path.join(dir, 'content', 'google-drive');
const tree = (): string[] =>
  fs.existsSync(target())
    ? fs
        .readdirSync(target(), { recursive: true, encoding: 'utf8' })
        .map((p) => p.split(path.sep).join('/'))
        .sort()
    : [];

describe('stagingDirFor', () => {
  it('places the account directly under the staging root', () => {
    const root = path.resolve('/s');
    expect(stagingDirFor(root, 'a@x.example')).toBe(
      path.join(root, 'a@x.example'),
    );
  });

  it('refuses anything that would resolve elsewhere (the dir is wiped)', () => {
    for (const bad of ['../../content', '..', '.', 'a/b', 'a\\b', '']) {
      expect(() => stagingDirFor(path.resolve('/s'), bad)).toThrow(
        /not a safe staging directory name/,
      );
    }
  });
});

describe('syncOne end to end', () => {
  it('dry run writes nothing anywhere', async () => {
    const r = fakeRunner();
    const log: string[] = [];
    const s = await syncOne(cfg, r.client, opts(drive(true), false, log));
    expect(s.queueNew).toBe(1);
    expect(
      log.some((l) => l.startsWith('NEW ext@example.org/Project - ')),
    ).toBe(true);
    expect(tree()).toEqual([]);
    expect(r.items.size + r.state.size).toBe(0);
  });

  it('syncs, stays idle when nothing changed, updates on change, and cleans up after un-share', async () => {
    const r = fakeRunner();
    const first = await syncOne(cfg, r.client, opts(drive(true), true));
    expect(first).toMatchObject({ processed: 1, seeded: 2, failed: 0 });
    const written = tree().filter((p) => p.endsWith('.txt'));
    expect(written).toHaveLength(1);
    expect(fs.readFileSync(path.join(target(), written[0]), 'utf8')).toBe(
      'hello',
    );

    const idle = await syncOne(cfg, r.client, opts(drive(true), true));
    expect(idle).toMatchObject({
      queueNew: 0,
      queueUpdates: 0,
      processed: 0,
      fileDeletes: 0,
      seeded: 0,
    });

    note.md5Checksum = 'v2';
    const changed = await syncOne(
      cfg,
      r.client,
      opts(drive(true, 'v2 body'), true),
    );
    note.md5Checksum = 'v1';
    expect(changed).toMatchObject({ queueUpdates: 1, processed: 1 });
    expect(fs.readFileSync(path.join(target(), written[0]), 'utf8')).toBe(
      'v2 body',
    );

    // Every share withdrawn: the file, its folders and both metas go.
    const gone = await syncOne(cfg, r.client, opts(drive(false), true));
    expect(gone).toMatchObject({
      fileDeletes: 1,
      metaDeletes: 2,
      guard: { tripped: false },
    });
    expect(tree()).toEqual([]);
    expect(
      r.items.get('google-drive|files:assistant@example.com')?.size ?? 0,
    ).toBe(0);
  });

  it('an idle run writes nothing to the ledger; a change writes only the changed record', async () => {
    const r = fakeRunner();
    let puts = 0;
    const counted: RunnerState = {
      ...r.client,
      setItem: (...args) => {
        puts++;
        r.client.setItem(...args);
      },
    };
    await syncOne(cfg, counted, opts(drive(true), true));
    expect(puts).toBeGreaterThan(0);

    puts = 0;
    await syncOne(cfg, counted, opts(drive(true), true));
    expect(puts).toBe(0);

    note.md5Checksum = 'v2';
    await syncOne(cfg, counted, opts(drive(true, 'v2 body'), true));
    note.md5Checksum = 'v1';
    // The changed record: pending, then written. Nothing else.
    expect(puts).toBeGreaterThan(0);
    expect(puts).toBeLessThanOrEqual(2);
  });

  it('survives a failed enumeration: nothing deleted, and the recovery run keeps copies even with no budget', async () => {
    const r = fakeRunner();
    await syncOne(cfg, r.client, opts(drive(true), true));
    const before = tree();

    const broken = drive(true);
    broken.listChildren = () => {
      throw new Error('503');
    };
    const failed = await syncOne(cfg, r.client, opts(broken, true));
    expect(failed.guard).toMatchObject({
      tripped: true,
      reason: 'enumeration-error',
    });
    expect(tree()).toEqual(before);

    const recovery = await syncOne(cfg, r.client, {
      ...opts(drive(true), true),
      budget: createRunBudget(BudgetConfigSchema.parse({}), 0), // spent
    });
    expect(recovery).toMatchObject({
      fileDeletes: 0,
      queueNew: 0,
      guard: { tripped: false },
    });
    expect(tree()).toEqual(before);
  });

  it('holds moves when a path lookup fails: no copy, folder or meta moves or goes until a clean run', async () => {
    // A folder owned inside a delegated domain: the owner's view resolves
    // its path (My Drive / Clients / Project).
    const owned = { ...folder, owners: [{ emailAddress: 'o@example.com' }] };
    const views = {
      'o@example.com|F': { ...owned, parents: ['C'] },
      'o@example.com|C': file({
        id: 'C',
        name: 'Clients',
        parents: ['root'],
        mimeType: FOLDER_MIME,
      }),
      'o@example.com|root': file({
        id: 'root',
        name: 'My Drive',
        mimeType: FOLDER_MIME,
      }),
    };
    const ownedDrive = (lookups: boolean): DriveClient => {
      const c = fakeDrive({
        sharedWithMe: [owned],
        children: [note],
        views: lookups ? views : {},
      });
      c.downloadTo = (_id, out) => {
        fs.writeFileSync(out, 'hello');
        return out;
      };
      return c;
    };

    const r = fakeRunner();
    await syncOne(cfg, r.client, opts(ownedDrive(true), true));
    const before = tree();
    expect(before.some((p) => p.startsWith('o@example.com/Clients - '))).toBe(
      true,
    );

    const log: string[] = [];
    const failed = await syncOne(
      cfg,
      r.client,
      opts(ownedDrive(false), true, log),
    );
    expect(failed.enumerationErrors).toHaveLength(1);
    expect(failed).toMatchObject({ moves: 0, heldMoves: 1, metaDeletes: 0 });
    expect(log.some((l) => l.startsWith('HOLD o@example.com/Clients - '))).toBe(
      true,
    );
    expect(tree()).toEqual(before);

    const clean = await syncOne(cfg, r.client, opts(ownedDrive(true), true));
    expect(clean).toMatchObject({ moves: 0, heldMoves: 0, fileDeletes: 0 });
    expect(clean.enumerationErrors).toEqual([]);
    expect(tree()).toEqual(before);
  });

  it('refuses a target dir that is a symlink, leaving the outside tree alone', async () => {
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'sentinel'), 'keep');
    fs.mkdirSync(path.join(dir, 'content'));
    fs.symlinkSync(outside, target());
    await expect(
      syncOne(cfg, fakeRunner().client, opts(drive(false), true)),
    ).rejects.toThrow(/symlink/);
    expect(fs.readdirSync(outside)).toEqual(['sentinel']);
  });
});
