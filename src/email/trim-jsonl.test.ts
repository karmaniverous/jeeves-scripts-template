import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { trimJsonlFiles } from './trim-jsonl.js';

const NOW = Date.parse('2026-10-04T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-jsonl-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const line = (daysAgo: number) =>
  JSON.stringify({ at: new Date(NOW - daysAgo * DAY).toISOString() });

function write(name: string, lines: string[]): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

describe('trimJsonlFiles', () => {
  it('drops lines older than maxDays and keeps newer and unparseable lines', () => {
    const p = write('account.jsonl', [
      line(10),
      line(6),
      'not json',
      JSON.stringify({ kind: 'no-at' }),
      '',
      line(0),
    ]);
    trimJsonlFiles(dir, 7, NOW);
    expect(fs.readFileSync(p, 'utf8')).toBe(
      [line(6), 'not json', line(0)].join('\n') + '\n',
    );
  });

  it('empties a file whose lines are all old', () => {
    const p = write('old.jsonl', [line(30)]);
    trimJsonlFiles(dir, 7, NOW);
    expect(fs.readFileSync(p, 'utf8')).toBe('');
  });

  it('never trims _runs-* logs or non-jsonl files', () => {
    const runs = write('_runs-account.jsonl', [line(30)]);
    const other = write('notes.txt', [line(30)]);
    trimJsonlFiles(dir, 7, NOW);
    expect(fs.readFileSync(runs, 'utf8')).toBe(line(30) + '\n');
    expect(fs.readFileSync(other, 'utf8')).toBe(line(30) + '\n');
  });

  it('skips entries it cannot read', () => {
    fs.mkdirSync(path.join(dir, 'folder.jsonl'));
    const p = write('account.jsonl', [line(30), line(1)]);
    trimJsonlFiles(dir, 7, NOW);
    expect(fs.statSync(path.join(dir, 'folder.jsonl')).isDirectory()).toBe(
      true,
    );
    expect(fs.readFileSync(p, 'utf8')).toBe(line(1) + '\n');
  });

  it('is a no-op for a missing directory', () => {
    expect(() => {
      trimJsonlFiles(path.join(dir, 'missing'), 7, NOW);
    }).not.toThrow();
    expect(fs.existsSync(path.join(dir, 'missing'))).toBe(false);
  });
});
