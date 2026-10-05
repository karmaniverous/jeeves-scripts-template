import { describe, expect, it } from 'vitest';

import { createDriveClient } from './drive-client.js';
import { fakeDrive, file } from './fake-drive.test-helper.js';
import { createPathResolver, UNKNOWN_OWNER } from './resolve-path.js';
import { FOLDER_MIME } from './types.js';

const opts = {
  impersonate: true,
  domains: ['example.com'],
  sharedDriveFallbackIdentity: null,
};

describe('resolveShare: My Drive', () => {
  // Real shape from the spike: `My Drive` root → a → b → shared file.
  const views = {
    'owner@example.com|f1': file({ id: 'f1', parents: ['b'] }),
    'owner@example.com|b': file({
      id: 'b',
      name: 'b',
      parents: ['a'],
      mimeType: FOLDER_MIME,
    }),
    'owner@example.com|a': file({
      id: 'a',
      name: 'a',
      parents: ['root'],
      mimeType: FOLDER_MIME,
    }),
    'owner@example.com|root': file({
      id: 'root',
      name: 'My Drive',
      mimeType: FOLDER_MIME,
    }),
  };
  const shared = file({
    id: 'f1',
    name: 'c.txt',
    owners: [{ emailAddress: 'Owner@Example.com' }],
    sharingUser: { emailAddress: 'owner@example.com' },
  });

  it('walks the owner chain and drops the `My Drive` root', () => {
    const share = createPathResolver(fakeDrive({ views }), opts).resolveShare(
      shared,
    );
    expect(share.root).toEqual({
      kind: 'identity',
      label: 'owner@example.com',
    });
    expect(share.ancestors.map((a) => a.name)).toEqual(['a', 'b']);
    expect(share.pathResolved).toBe(true);
  });

  it('caches folder lookups within a run', () => {
    const client = fakeDrive({ views });
    const resolver = createPathResolver(client, opts);
    resolver.resolveShare(shared);
    resolver.resolveShare(shared);
    expect(
      client.calls.filter((c) => c === 'get:owner@example.com|a'),
    ).toHaveLength(1);
  });

  it('places external owners flat under their identity root (spec §4.3)', () => {
    const ext = file({
      id: 'x',
      owners: [{ emailAddress: 'someone@example.org' }],
    });
    const share = createPathResolver(fakeDrive({}), opts).resolveShare(ext);
    expect(share.root.label).toBe('someone@example.org');
    expect(share.ancestors).toEqual([]);
    expect(share.pathResolved).toBe(false);
  });

  it('falls back to the sharer, then unknown-owner', () => {
    const r = createPathResolver(fakeDrive({}), opts);
    expect(
      r.resolveShare(
        file({ id: 's', sharingUser: { emailAddress: 'S@x.example' } }),
      ).root.label,
    ).toBe('s@x.example');
    expect(r.resolveShare(file({ id: 'u' })).root.label).toBe(UNKNOWN_OWNER);
  });

  it('does not impersonate when impersonation is off', () => {
    const client = fakeDrive({ views });
    const share = createPathResolver(client, {
      ...opts,
      impersonate: false,
    }).resolveShare(shared);
    expect(share.pathResolved).toBe(false);
    expect(client.calls).toEqual([]);
  });

  it('marks the path unresolved when the walk fails', () => {
    const share = createPathResolver(
      fakeDrive({ views: {} }),
      opts,
    ).resolveShare(shared);
    expect(share.pathResolved).toBe(false);
    expect(share.ancestors).toEqual([]);
  });
});

describe('resolveShare: shared drives', () => {
  const views = {
    'jason@example.com|s': file({
      id: 's',
      parents: ['ns'],
      driveId: 'D1',
      mimeType: FOLDER_MIME,
    }),
    'jason@example.com|ns': file({
      id: 'ns',
      name: 'not shared',
      parents: ['D1'],
      driveId: 'D1',
      mimeType: FOLDER_MIME,
    }),
    // The drive root folder is named `Drive` for every drive; never used.
    'jason@example.com|D1': file({
      id: 'D1',
      name: 'Drive',
      mimeType: FOLDER_MIME,
    }),
  };
  const shared = file({
    id: 's',
    name: 'shared',
    mimeType: FOLDER_MIME,
    driveId: 'D1',
    sharingUser: { emailAddress: 'jason@example.com' },
  });

  it('impersonates the sharer and names the drive via drives.list', () => {
    const client = fakeDrive({
      views,
      driveNames: { 'jason@example.com': { D1: 'Test' } },
    });
    const share = createPathResolver(client, opts).resolveShare(shared);
    expect(share.root).toEqual({ kind: 'drive', label: 'Test', driveId: 'D1' });
    expect(share.ancestors.map((a) => a.name)).toEqual(['not shared']);
    expect(share.isFolder).toBe(true);
  });

  it('leaves the drive name null when it is unreadable', () => {
    const share = createPathResolver(fakeDrive({ views }), opts).resolveShare(
      shared,
    );
    expect(share.root.label).toBeNull();
  });

  it('uses the fallback identity for an external sharer', () => {
    const ext = {
      ...shared,
      sharingUser: { emailAddress: 'out@other.example' },
    };
    const client = fakeDrive({
      views: {},
      driveNames: { 'admin@example.com': { D1: 'Ops' } },
    });
    const share = createPathResolver(client, {
      ...opts,
      sharedDriveFallbackIdentity: 'admin@example.com',
    }).resolveShare(ext);
    expect(share.root.label).toBe('Ops');
  });
});

describe('drive-client', () => {
  it('passes --readonly on every gog call (the only write guard)', () => {
    const seen: string[][] = [];
    const exec = (args: string[]): string => {
      seen.push(args);
      if (args.includes('download')) return '{"path":"/tmp/x.md","size":1}';
      if (args.includes('revisions'))
        return '{"revisions":[{"id":"1"},{"id":"7"}]}';
      if (args.includes('drives')) return '{"drives":[]}';
      if (args.includes('metadata')) return '{"sheets":[]}';
      if (args.includes('get')) return '{"values":[]}';
      if (args.includes('raw'))
        return '{"id":"x","name":"x","mimeType":"text/plain"}';
      return '{"files":[]}';
    };
    const c = createDriveClient('assistant@example.com', exec);
    c.listSharedWithMe();
    c.listChildren(['a', 'b']);
    c.getFile('x', 'owner@example.com');
    c.listDriveNames('owner@example.com');
    expect(c.latestRevisionId('x')).toBe('7');
    c.exportTo('x', 'md', '/tmp/x');
    c.downloadTo('x', '/tmp/x');
    c.sheetTabs('x');
    c.sheetValues('x', "It's");
    expect(seen.length).toBeGreaterThanOrEqual(9);
    for (const args of seen) expect(args[0]).toBe('--readonly');
    expect(seen.find((a) => a.includes('get'))).toContain("'It''s'");
  });

  it('batches children of many parents into one query', () => {
    const seen: string[][] = [];
    const c = createDriveClient('a@example.com', (args) => {
      seen.push(args);
      return '{"files":[]}';
    });
    c.listChildren(Array.from({ length: 30 }, (_, i) => `p${String(i)}`));
    expect(seen).toHaveLength(2);
    expect(seen[0].join(' ')).toContain("'p0' in parents or 'p1' in parents");
  });
});
