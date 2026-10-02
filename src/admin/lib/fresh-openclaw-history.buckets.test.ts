/**
 * hasOpenClawBuckets over a real temp bucket store, and the order of the
 * checks in isFreshOpenClawHistory. End-to-end behaviour through
 * runCollect is in fresh-openclaw-history.test.ts.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  hasOpenClawBuckets,
  isFreshOpenClawHistory,
} from './fresh-openclaw-history.js';

const channels = (...keys: string[]) => ({
  hour: '2026-06-14T09',
  channels: Object.fromEntries(keys.map((k) => [k, { models: {} }])),
});

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-fresh-buckets-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Write `content` (JSON unless a string) at `{root}/<rel>`. */
function put(rel: string, content: unknown): void {
  const fp = path.join(root, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(
    fp,
    typeof content === 'string' ? content : JSON.stringify(content),
  );
}

describe('hasOpenClawBuckets', () => {
  it('is false when the bucket root does not exist', () => {
    expect(hasOpenClawBuckets(path.join(root, 'missing'))).toBe(false);
  });

  it.each<[string, Record<string, unknown>, boolean]>([
    ['an empty root', {}, false],
    [
      'only Claude Code buckets across months and years',
      {
        '2025/12/2025-12-31T23.json': channels('cc:jeeves'),
        '2026/01/2026-01-01T00.json': channels('cc:a', 'cc:b'),
      },
      false,
    ],
    [
      'an OpenClaw bucket in a later month than Claude Code buckets',
      {
        '2026/05/2026-05-01T00.json': channels('cc:jeeves'),
        '2026/06/2026-06-14T09.json': channels('slack:channel:#g'),
      },
      true,
    ],
    [
      'an OpenClaw bucket in a later year',
      {
        '2025/12/2025-12-31T23.json': channels('cc:jeeves'),
        '2026/01/2026-01-01T00.json': channels('unknown'),
      },
      true,
    ],
    [
      'OpenClaw data only outside the {YYYY}/{MM} layout or in non-JSON files',
      {
        'token-rates.json': channels('slack:channel:#g'),
        'slack-dm-names.json': channels('slack:dm:U1'),
        'archive/06/2026-06-14T09.json': channels('slack:channel:#g'),
        '2026/6/2026-06-14T09.json': channels('slack:channel:#g'),
        '2026/06/2026-06-14T09.json.tmp': channels('slack:channel:#g'),
      },
      false,
    ],
    ['an array channels value', { '2026/06/x.json': { channels: [] } }, true],
    ['a bucket with no channels', { '2026/06/x.json': { hour: 'x' } }, true],
    ['a JSON null bucket', { '2026/06/x.json': 'null' }, true],
  ])('%s → %s', (_label, files, expected) => {
    for (const [rel, content] of Object.entries(files)) put(rel, content);

    expect(hasOpenClawBuckets(root)).toBe(expected);
  });
});

describe('isFreshOpenClawHistory', () => {
  it('does not scan buckets when the legacy cursor has an entry', () => {
    const scan = vi.fn(() => false);

    expect(
      isFreshOpenClawHistory(
        { 'a.jsonl': { byteOffset: 1, lastTimestamp: 1 } },
        scan,
      ),
    ).toBe(false);
    expect(scan).not.toHaveBeenCalled();
  });
});
