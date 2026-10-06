import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addPendingModels,
  readPendingModels,
  writePendingModels,
} from './rate-card-pending.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rate-card-pending-'));
  file = path.join(dir, 'token-rates.pending.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('rate-card-pending', () => {
  it('reads a missing file as empty', () => {
    expect(readPendingModels(file)).toEqual([]);
  });

  it('reads malformed or non-array content as empty', () => {
    fs.writeFileSync(file, '{not json');
    expect(readPendingModels(file)).toEqual([]);
    fs.writeFileSync(file, '{"a":1}');
    expect(readPendingModels(file)).toEqual([]);
  });

  it('drops non-string, blank and duplicate entries', () => {
    fs.writeFileSync(file, JSON.stringify(['a/m', 1, '', ' ', 'a/m', 'b/n']));
    expect(readPendingModels(file)).toEqual(['a/m', 'b/n']);
  });

  it('merges new ids with existing ones', () => {
    addPendingModels(file, ['a/m']);
    addPendingModels(file, ['b/n', 'a/m']);
    expect(readPendingModels(file)).toEqual(['a/m', 'b/n']);
  });

  it('removes the file when written empty', () => {
    writePendingModels(file, ['a/m']);
    expect(fs.existsSync(file)).toBe(true);
    writePendingModels(file, []);
    expect(fs.existsSync(file)).toBe(false);
  });
});
