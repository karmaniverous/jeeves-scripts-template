/**
 * Tests for bucket-maintenance: backup naming beside each bucket, dry-run
 * non-mutation, deletion, and a failed backup copy aborting before any
 * bucket is deleted.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bucketPath } from './bucket-io.js';
import { backupBucketFiles, deleteBucketFiles } from './bucket-maintenance.js';

const NOW = new Date('2026-09-28T12:34:56.789Z');
const STAMP = '2026-09-28T12-34-56-789Z';
const HOURS = ['2026-09-24T09', '2026-09-24T10', '2026-09-24T11'];

let dir: string;

function writeBucket(hour: string): string {
  const fp = bucketPath(hour, dir);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify({ hour, channels: {} }));
  return fp;
}

function listAll(): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bucket-maint-'));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('backupBucketFiles', () => {
  it('copies each existing bucket beside itself with one timestamp', () => {
    const a = writeBucket(HOURS[0]);
    writeBucket(HOURS[2]);

    expect(backupBucketFiles(HOURS, false, '[t]', dir)).toBe(2);

    const backup = a.replace(/\.json$/, `.backup-${STAMP}.json`);
    expect(fs.readFileSync(backup, 'utf8')).toBe(fs.readFileSync(a, 'utf8'));
    expect(listAll()).toEqual([
      `${HOURS[0]}.backup-${STAMP}.json`,
      `${HOURS[0]}.json`,
      `${HOURS[2]}.backup-${STAMP}.json`,
      `${HOURS[2]}.json`,
    ]);
  });

  it('dry run counts but writes nothing', () => {
    writeBucket(HOURS[1]);
    const before = listAll();

    expect(backupBucketFiles(HOURS, true, '[t]', dir)).toBe(1);
    expect(listAll()).toEqual(before);
  });

  it('throws on a failed copy, so a following delete never runs', () => {
    const fp = writeBucket(HOURS[0]);
    // Occupy the backup path: the copy fails (never overwrites).
    fs.mkdirSync(fp.replace(/\.json$/, `.backup-${STAMP}.json`));

    const rebuild = () => {
      backupBucketFiles(HOURS, false, '[t]', dir);
      deleteBucketFiles(HOURS, false, '[t]', dir);
    };
    expect(rebuild).toThrow();
    expect(fs.existsSync(fp)).toBe(true);
  });
});

describe('deleteBucketFiles', () => {
  it('deletes existing buckets in range and leaves backups', () => {
    writeBucket(HOURS[0]);
    writeBucket(HOURS[1]);
    backupBucketFiles(HOURS, false, '[t]', dir);

    expect(deleteBucketFiles(HOURS, false, '[t]', dir)).toBe(2);
    expect(listAll()).toEqual([
      `${HOURS[0]}.backup-${STAMP}.json`,
      `${HOURS[1]}.backup-${STAMP}.json`,
    ]);
  });

  it('dry run deletes nothing', () => {
    writeBucket(HOURS[0]);

    expect(deleteBucketFiles(HOURS, true, '[t]', dir)).toBe(1);
    expect(listAll()).toEqual([`${HOURS[0]}.json`]);
  });
});
