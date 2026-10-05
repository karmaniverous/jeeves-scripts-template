import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertNoSymlinks,
  metaLockHeld,
  moveFile,
  prepareStaging,
  pruneDirs,
  safeJoin,
  scanTree,
  subtreeHasFile,
  writeAtomic,
} from './apply.js';
import { file } from './fake-drive.test-helper.js';
import { withFrontmatter } from './frontmatter.js';

let root: string;
const put = (rel: string, body = 'x'): void => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdrive-apply-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('apply', () => {
  it('refuses paths that escape the target dir, lexically or through a symlink', () => {
    expect(() => safeJoin(root, '../x')).toThrow(/escapes/);
    expect(() => safeJoin(root, '')).toThrow(/escapes/);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gdrive-outside-'));
    fs.writeFileSync(path.join(outside, 'sentinel'), 'keep');
    fs.symlinkSync(outside, path.join(root, 'link'));
    expect(() => safeJoin(root, 'link/sentinel')).toThrow(/symlink/);
    expect(() => {
      writeAtomic(root, 'link/new.md', 'x', path.join(root, 'tmp'));
    }).toThrow(/symlink/);
    expect(() => {
      assertNoSymlinks(root, path.join(root, 'link'));
    }).toThrow(/symlink/);
    expect(fs.readdirSync(outside)).toEqual(['sentinel']);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('scans files, dirs and meta dirs, excluding .meta contents', () => {
    put('m/a/f.md');
    put('m/.meta/meta.json');
    put('.gitignore');
    put('.cache/x');
    expect(scanTree(root)).toEqual({
      files: ['m/a/f.md'],
      metaDirs: ['m'],
      dirs: ['m', 'm/a'],
    });
  });

  it('writes atomically via staging and moves files', () => {
    const staging = path.join(root, '..', `${path.basename(root)}-staging`);
    const target = path.join(root, 't');
    prepareStaging(staging, target);
    writeAtomic(target, 'a/b.md', 'hello', path.join(staging, 'x'));
    moveFile(target, 'a/b.md', 'c/d.md');
    expect(fs.readFileSync(path.join(target, 'c/d.md'), 'utf8')).toBe('hello');
    fs.rmSync(staging, { recursive: true, force: true });
  });

  it('prunes empty dirs and approved meta-only dirs, never live ones', () => {
    put('keep/f.md');
    put('gone/.meta/meta.json');
    put('kept-meta/.meta/meta.json');
    fs.mkdirSync(path.join(root, 'empty/deeper'), { recursive: true });
    const res = pruneDirs(root, new Set(['keep']), ['gone'], 30);
    expect(res.removedDirs.sort()).toEqual(['empty', 'empty/deeper', 'gone']);
    expect(fs.existsSync(path.join(root, 'kept-meta/.meta'))).toBe(true);
  });

  it('skips meta dirs with a live lock', () => {
    put('locked/.meta/.lock');
    const res = pruneDirs(root, new Set(), ['locked'], 30);
    expect(res.heldLocks).toEqual(['locked']);
    expect(
      metaLockHeld(path.join(root, 'locked'), 30, Date.now() + 31 * 60_000),
    ).toBe(false);
  });

  it('detects files in a subtree (seeding precondition)', () => {
    put('m/a/f.md');
    expect(subtreeHasFile(root, 'm')).toBe(true);
    expect(subtreeHasFile(root, 'nope')).toBe(false);
  });
});

describe('frontmatter', () => {
  it('emits YAML-safe fields', () => {
    const out = withFrontmatter(
      {
        file: file({
          id: 'x',
          name: 'a "b"',
          owners: [{ emailAddress: 'o@example.com' }],
        }),
        root: { kind: 'identity', label: 'o@example.com' },
        ancestors: [],
        pathResolved: true,
        shareIds: ['x'],
      },
      'body',
    );
    expect(out).toMatch(/^---\nsource: "google-drive"\ndriveFileId: "x"/);
    expect(out).toContain('drivePath: "o@example.com / a \\"b\\""');
    expect(out.endsWith('body\n')).toBe(true);
  });
});
