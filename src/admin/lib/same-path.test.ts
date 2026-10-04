import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isSamePath } from './same-path.js';

let root: string;
let live: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'same-path-'));
  live = path.join(root, 'state', 'token-metrics');
  fs.mkdirSync(live, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A directory link (a junction on Windows, which needs no privilege). */
function linkDir(target: string, link: string): void {
  fs.symlinkSync(target, link, 'junction');
}

describe('isSamePath', () => {
  it('matches the same directory written differently', () => {
    expect(isSamePath(live, live)).toBe(true);
    expect(isSamePath(`${live}${path.sep}`, live)).toBe(true);
    expect(isSamePath(path.join(live, '..', 'token-metrics'), live)).toBe(true);
  });

  it('matches an empty live store reached through a symlink', () => {
    const alias = path.join(root, 'alias');
    linkDir(live, alias);
    expect(isSamePath(alias, live)).toBe(true);
  });

  it('matches a not-yet-existing path under a symlinked parent', () => {
    const parentAlias = path.join(root, 'state-alias');
    linkDir(path.join(root, 'state'), parentAlias);
    const liveChild = path.join(live, 'scratch');
    expect(isSamePath(path.join(parentAlias, 'token-metrics'), live)).toBe(
      true,
    );
    expect(
      isSamePath(path.join(parentAlias, 'token-metrics', 'scratch'), liveChild),
    ).toBe(true);
  });

  it('does not match an isolated scratch directory', () => {
    const scratch = path.join(root, 'scratch');
    fs.mkdirSync(scratch);
    expect(isSamePath(scratch, live)).toBe(false);
    expect(isSamePath(path.join(root, 'missing'), live)).toBe(false);
    // A directory inside the live store is not the live store.
    expect(isSamePath(path.join(live, '2026'), live)).toBe(false);
  });
});
