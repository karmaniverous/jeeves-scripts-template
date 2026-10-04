/**
 * Schema-23 channel metadata + scan integration: real-shaped session nodes,
 * conversations and 2026.9 transcript events produce metadata-derived
 * channel keys; text rules apply only where metadata is absent.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HourlyBucket } from '../../types/token-metrics.js';
import {
  assistantUsage,
  runtimeContext,
  sessionHeader,
  slackChannelEntry,
  slackDirectEntry,
  userMessage,
} from './real-events-v23.js';
import {
  channelNameFromLabel,
  loadV23Meta,
  parseNodeEntry,
} from './schema-v23-meta.js';
import { createV23Fixture } from './test-fixture-v23.js';

const T10 = '2026-09-25T10:30:00Z';
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-db-meta-'));
  fs.writeFileSync(
    path.join(root, 'token-rates.json'),
    JSON.stringify({
      updatedAt: '2026-09-25T00:00:00Z',
      models: {
        'anthropic/claude-sonnet-4-6': {
          input: 3,
          output: 15,
          cacheRead: 0.3,
          cacheWrite: 3.75,
        },
      },
    }),
  );
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('parseNodeEntry / channelNameFromLabel', () => {
  it('reads names from a real-shaped entry', () => {
    expect(
      parseNodeEntry(
        null,
        JSON.stringify({
          ...slackDirectEntry('U1', 'Paul Wright'),
          parentSessionKey: 'agent:main:slack:channel:c1',
        }),
        null,
      ),
    ).toEqual({
      label: undefined,
      groupChannel: undefined,
      displayName: undefined,
      originLabel: 'Paul Wright',
      parentKey: 'agent:main:slack:channel:c1',
    });
  });

  it('tolerates malformed entry JSON', () => {
    expect(parseNodeEntry('lbl', '{', null).label).toBe('lbl');
  });

  it.each([
    ['slack:t000example2#jeeves-meta', '#jeeves-meta'],
    ['slack:g-c000example3', undefined],
    ["Slack thread #D000EXAMPLE1: Done. Here's", undefined],
    [undefined, undefined],
  ])('channelNameFromLabel(%j)', (label, name) => {
    expect(channelNameFromLabel(label)).toBe(name);
  });
});

describe('loadV23Meta', () => {
  it('resolves names from nodes, conversations, parents and archive keys', () => {
    const fx = createV23Fixture(root);
    fx.addHotSession('ch', [sessionHeader('ch')], [], {
      key: 'agent:main:slack:channel:c000example2',
      entry: slackChannelEntry('C000EXAMPLE2', 'ops-ceo'),
    });
    fx.addHotSession('sub', [sessionHeader('sub')], [], {
      key: 'agent:main:subagent:1',
      entry: { spawnedBy: 'agent:main:slack:channel:c000example2' },
    });
    fx.addConversation('C0NAMEDXX', 'slack:t000example2#acme-dev');
    fx.addHotSession('thr', [sessionHeader('thr')], [], {
      key: 'agent:main:slack:channel:c0namedxx:thread:1.2',
    });
    fx.close();

    const db = new DatabaseSync(fx.dbPath, { readOnly: true });
    try {
      const meta = loadV23Meta(db);
      expect(meta.forSession('ch')?.channelName).toBe('#ops-ceo');
      expect(meta.forSession('sub')?.parent?.channelName).toBe('#ops-ceo');
      expect(meta.forSession('thr')?.channelName).toBe('#acme-dev');
      expect(meta.forSession('missing')).toBeUndefined();
      expect(
        meta.forKey('agent:main:slack:channel:c000example2:thread:9')
          .channelName,
      ).toBe('#ops-ceo');
    } finally {
      db.close();
    }
  });
});

describe('loadV23Meta parent linkage', () => {
  it('links parents transitively and flags deleted ones', () => {
    const fx = createV23Fixture(root);
    const node = (key: string, spawnedBy: string, label?: string) => ({
      key,
      label,
      entry: { spawnedBy, spawnDepth: 1 },
    });
    fx.addHotSession('ch', [sessionHeader('ch')], [], {
      key: 'agent:main:slack:channel:c000example2',
      entry: slackChannelEntry('C000EXAMPLE2', 'ops-ceo'),
    });
    fx.addHotSession(
      's1',
      [],
      [],
      node(
        'agent:main:subagent:1',
        'agent:main:slack:channel:c000example2',
        'orchestrator',
      ),
    );
    fx.addHotSession(
      's2',
      [],
      [],
      node('agent:main:subagent:2', 'agent:main:subagent:1'),
    );
    fx.addHotSession(
      's3',
      [],
      [],
      node('agent:main:subagent:3', 'agent:main:subagent:gone', 'review'),
    );
    fx.close();

    const db = new DatabaseSync(fx.dbPath, { readOnly: true });
    try {
      const meta = loadV23Meta(db);
      const nested = meta.forSession('s2');
      expect(nested?.parent?.parent?.channelName).toBe('#ops-ceo');
      expect(nested?.parent?.missing).toBeUndefined();
      expect(meta.forSession('s3')?.parent).toEqual({
        sessionKey: 'agent:main:subagent:gone',
        missing: true,
      });
    } finally {
      db.close();
    }
  });
});

describe('scanOpenClawDb channel naming (2026.9 events)', () => {
  async function scan(dbPath: string, sessionsDir: string) {
    vi.resetModules();
    vi.doMock(
      '../../../lib/constants.js',
      async (importOriginal: () => Promise<Record<string, unknown>>) => ({
        ...(await importOriginal()),
        TOKEN_RATES_PATH: path.join(root, 'token-rates.json'),
      }),
    );
    const { scanOpenClawDb } = await import('./scan-openclaw-db.js');
    const buckets = new Map<string, HourlyBucket>();
    scanOpenClawDb({
      dbPath,
      sessionsDir,
      cursors: {},
      options: { fromMs: 0, toMs: Date.parse('2026-09-25T12:00:00Z') },
      buckets,
      seenModels: new Set(),
    });
    return Object.keys(buckets.get('2026-09-25T10')?.channels ?? {}).sort();
  }

  it('names channels from metadata, falling back to text rules', async () => {
    const fx = createV23Fixture(root);
    fx.addHotSession(
      'dm',
      [
        sessionHeader('dm'),
        userMessage('hi'),
        runtimeContext('Alex Example'),
        assistantUsage(T10),
      ],
      [2],
      {
        key: 'agent:main:slack:direct:u000example2',
        entry: slackDirectEntry('U000EXAMPLE2', 'Alex Example'),
      },
    );
    fx.addHotSession(
      'worker',
      [
        sessionHeader('worker'),
        userMessage('[Subagent Task] x'),
        assistantUsage(T10),
      ],
      [],
      { key: 'agent:main:subagent:2', label: 'worker-refresh-' },
    );
    fx.addHotSession('kid', [sessionHeader('kid'), assistantUsage(T10)], [], {
      key: 'agent:main:subagent:3',
      label: 'jeeves-tools e2e #5',
      entry: { spawnedBy: 'agent:main:slack:direct:u000example2' },
    });
    fx.addHotSession(
      'runner',
      [sessionHeader('runner'), assistantUsage(T10)],
      [],
      {
        key: 'agent:main:subagent:4',
        label: 'worker-generate',
        entry: { spawnedBy: 'agent:main:main' },
      },
    );
    fx.addHotSession('legacy', [
      sessionHeader('legacy'),
      userMessage('[Subagent Task] in /repos/acme/widget.'),
      assistantUsage(T10),
    ]);
    fx.close();

    expect(await scan(fx.dbPath, fx.sessionsDir)).toEqual([
      'runner:generate',
      'slack:dm:alex-example',
      'subagent:label:worker-refresh-',
      'subagent:repo:acme/widget',
    ]);
  });
});
