import { describe, expect, it } from 'vitest';

import { SyncEntrySchema } from './config.js';
import { enumerate } from './enumerate.js';
import { fakeDrive, file } from './fake-drive.test-helper.js';
import { createPathResolver } from './resolve-path.js';
import { layout } from './tree.js';
import { FOLDER_MIME } from './types.js';

const pathOpts = {
  impersonate: true,
  domains: ['example.com'],
  sharedDriveFallbackIdentity: null,
};
const ext = {
  owners: [{ emailAddress: 'ext@example.org' }],
  sharingUser: { emailAddress: 'ext@example.org' },
};

describe('enumerate', () => {
  // External owner shares folder F (with child folder G holding g.md) and,
  // separately, the file g.md itself.
  const F = file({ id: 'F', name: 'Project X', mimeType: FOLDER_MIME, ...ext });
  const G = file({
    id: 'G',
    name: 'specs',
    mimeType: FOLDER_MIME,
    parents: ['F'],
  });
  const g = file({ id: 'g', name: 'api.md', parents: ['G'] });
  const gDirect = file({ id: 'g', name: 'api.md', ...ext });

  it('recurses shared folders and keeps child structure', () => {
    const client = fakeDrive({ sharedWithMe: [F], children: [G, g] });
    const snap = enumerate(client, createPathResolver(client, pathOpts));
    expect(snap.files).toHaveLength(1);
    expect(snap.files[0].ancestors.map((a) => a.name)).toEqual([
      'Project X',
      'specs',
    ]);
    expect(snap.files[0].root.label).toBe('ext@example.org');
  });

  it('places a doubly-reachable file once, under its fullest visible path', () => {
    const client = fakeDrive({ sharedWithMe: [gDirect, F], children: [G, g] });
    const snap = enumerate(client, createPathResolver(client, pathOpts));
    expect(snap.files).toHaveLength(1);
    expect(snap.files[0].ancestors.map((a) => a.name)).toEqual([
      'Project X',
      'specs',
    ]);
    expect(snap.files[0].shareIds).toEqual(['F', 'g']);
    // The direct file share's own location is moved under the folder too.
    expect(snap.shares.find((s) => s.id === 'g')?.ancestors).toHaveLength(2);
  });

  it('treats each member shared drive as a whole-drive share', () => {
    const top = file({
      id: 'T',
      name: 'Top',
      mimeType: FOLDER_MIME,
      parents: ['D9'],
      driveId: 'D9',
    });
    const doc = file({
      id: 't',
      name: 'notes.md',
      parents: ['T'],
      driveId: 'D9',
    });
    const client = fakeDrive({
      children: [top, doc],
      driveNames: { 'assistant@example.com': { D9: 'Ops' } },
    });
    const snap = enumerate(client, createPathResolver(client, pathOpts));
    expect(snap.shares).toEqual([
      expect.objectContaining({
        id: 'D9',
        isDriveRoot: true,
        root: { kind: 'drive', label: 'Ops', driveId: 'D9' },
      }),
    ]);
    expect(snap.files.map((f) => f.ancestors.map((x) => x.name))).toEqual([
      ['Top'],
    ]);
    const cfg = SyncEntrySchema.parse({ account: 'a@example.com' });
    const classes = new Map([
      ['t', { namingClass: 'native-text' as const, mimeType: 'text/plain' }],
    ]);
    const out = layout(snap.files, snap.shares, classes, cfg.naming);
    expect(out.paths.get('t')).toMatch(
      /^Ops - [a-z2-7]{8}\/Top - [a-z2-7]{8}\/notes - [a-z2-7]{8}\.md$/,
    );
    expect(out.shareDirs[0].sharePointDir).toBe(out.shareDirs[0].rootDir);
  });

  it('records a non-fatal error when a folder listing fails', () => {
    const client = fakeDrive({ sharedWithMe: [F] });
    client.listChildren = () => {
      throw new Error('boom');
    };
    const snap = enumerate(client, createPathResolver(client, pathOpts));
    expect(snap.errors).toHaveLength(1);
  });
});

describe('layout', () => {
  const cfg = SyncEntrySchema.parse({
    account: 'a@example.com',
    pathResolution: { domains: ['example.com'] },
  });

  it('builds tagged paths, root and share-point dirs', () => {
    const F = file({
      id: 'F',
      name: 'Project X',
      mimeType: FOLDER_MIME,
      ...ext,
    });
    const doc = file({
      id: 'd',
      name: 'Plan',
      mimeType: 'application/vnd.google-apps.document',
      parents: ['F'],
    });
    const client = fakeDrive({ sharedWithMe: [F], children: [doc] });
    const snap = enumerate(client, createPathResolver(client, pathOpts));
    const classes = new Map([
      ['d', { namingClass: 'google-native' as const, mimeType: doc.mimeType }],
    ]);
    const out = layout(snap.files, snap.shares, classes, cfg.naming);
    const p = out.paths.get('d') ?? '';
    expect(p).toMatch(
      /^ext@example\.org\/Project X - [a-z2-7]{8}\/Plan - [a-z2-7]{8}\.md$/,
    );
    expect(out.shareDirs).toEqual([
      {
        shareId: 'F',
        rootDir: 'ext@example.org',
        sharePointDir: p.split('/').slice(0, 2).join('/'),
      },
    ]);
  });

  it('tags shared-drive roots and falls back when the name is unreadable', () => {
    const s = file({ id: 's', name: 'a.txt', driveId: 'D1' });
    const client = fakeDrive({ sharedWithMe: [s] });
    const snap = enumerate(client, createPathResolver(client, pathOpts));
    const classes = new Map([
      ['s', { namingClass: 'native-text' as const, mimeType: 'text/plain' }],
    ]);
    const p =
      layout(snap.files, snap.shares, classes, cfg.naming).paths.get('s') ?? '';
    expect(p).toMatch(/^shared-drive - [a-z2-7]{8}\/a - [a-z2-7]{8}\.txt$/);
  });
});
