import { describe, expect, it } from 'vitest';

import { channelFromMeta } from './channel-from-meta.js';
import { isSubagentKey, runnerChannel } from './subagent-rollup.js';
import type { SessionMeta } from './types.js';

const OPS_CEO: SessionMeta = {
  sessionKey: 'agent:main:slack:channel:c0aujrk8dtm',
  channelName: '#ops-ceo',
};
const MAIN: SessionMeta = { sessionKey: 'agent:main:main' };

/** A subagent session with an optional label and parent. */
function sub(id: string, parent?: SessionMeta, label?: string): SessionMeta {
  const meta: SessionMeta = { sessionKey: `agent:main:subagent:${id}` };
  if (label) meta.label = label;
  if (parent) meta.parent = parent;
  return meta;
}

const keyOf = (meta: SessionMeta) => channelFromMeta(meta)?.key;

describe('subagent rollup', () => {
  it('rolls a labelled subagent up to its Slack channel (1 level)', () => {
    expect(keyOf(sub('a', OPS_CEO, 'jeeves-tools e2e #5: rerun'))).toBe(
      'slack:channel:#ops-ceo',
    );
  });

  it('rolls nested subagents up to the root channel', () => {
    const child = sub('b', OPS_CEO, 'orchestrator');
    const grandchild = sub('c', child, 'fix lint');
    expect(keyOf(sub('d', grandchild))).toBe('slack:channel:#ops-ceo');
  });

  it('rolls up to a Slack DM, Telegram group or cron root', () => {
    const dm: SessionMeta = {
      sessionKey: 'agent:main:slack:direct:u0ab7j9rchf',
      peerName: 'Jason Williscroft',
    };
    const cron: SessionMeta = {
      sessionKey: 'agent:main:cron:bf9f',
      label: 'Cron: Nightly',
    };
    expect(keyOf(sub('e', dm, 'x'))).toBe('slack:dm:jason-williscroft');
    expect(keyOf(sub('f', sub('g', cron, 'y')))).toBe('cron:Nightly');
  });

  it('resolves a deleted Slack parent from its session key alone', () => {
    const deleted: SessionMeta = {
      sessionKey: 'agent:main:slack:channel:c0aujrk8dtm:thread:1.2',
      channelName: '#ops-ceo',
      missing: true,
    };
    expect(keyOf(sub('h', deleted, 'z'))).toBe('slack:channel:#ops-ceo');
  });

  it('falls back to the own label when a subagent parent is deleted', () => {
    const gone: SessionMeta = { ...sub('gone', OPS_CEO), missing: true };
    gone.parent = undefined;
    expect(keyOf(sub('i', gone, 'worker-vc-ops-c'))).toBe(
      'subagent:label:worker-vc-ops-c',
    );
    expect(keyOf(sub('j', gone, 'review PR'))).toBe('subagent:label:review PR');
    expect(keyOf(sub('k', gone))).toBeUndefined();
  });

  it('keeps the own label when no linkage is recorded', () => {
    expect(keyOf(sub('l', undefined, 'meta-critic-1cd90a43'))).toBe(
      'meta-critic',
    );
  });

  it('buckets runner workers under main as runner:<job>', () => {
    expect(keyOf(sub('m', MAIN, 'worker-vc-ops-c'))).toBe('runner:vc-ops-c');
    expect(channelFromMeta(sub('n', MAIN, 'worker-refresh-'))?.name).toBe(
      'Runner: refresh-',
    );
  });

  it('rolls a worker sub-subagent up to the worker bucket', () => {
    const worker = sub('o', MAIN, 'worker-generate');
    expect(keyOf(sub('p', sub('q', worker, 'research')))).toBe(
      'runner:generate',
    );
  });

  it('names main-rooted non-worker subagents by the topmost label', () => {
    const top = sub('r', MAIN, 'meta-architect-7958af1d');
    expect(keyOf(sub('s', top, 'helper'))).toBe('meta-architect');
    const labelled = sub('t', MAIN, 'jeeves-tools e2e #5');
    expect(keyOf(sub('u', labelled))).toBe(
      'subagent:label:jeeves-tools e2e #5',
    );
    expect(keyOf(sub('v', MAIN))).toBeUndefined();
  });

  it('stops on over-long or cyclic chains and uses the own label', () => {
    let chain = sub('root', OPS_CEO);
    for (let i = 0; i < 20; i++) chain = sub(String(i), chain);
    chain.label = 'deep';
    expect(keyOf(chain)).toBe('subagent:label:deep');
  });
});

describe('runnerChannel / isSubagentKey', () => {
  it.each([
    ['worker-vc-ops-t', 'runner:vc-ops-t'],
    ['worker-', undefined],
    ['workers-x', undefined],
    ['worker-a b', undefined],
    [undefined, undefined],
  ])('runnerChannel(%j)', (label, key) => {
    expect(runnerChannel(label)?.key).toBe(key);
  });

  it('recognises subagent keys only', () => {
    expect(isSubagentKey('agent:main:subagent:1')).toBe(true);
    expect(isSubagentKey('agent:main:slack:channel:c1')).toBe(false);
  });
});
