import { describe, expect, it, vi } from 'vitest';

vi.mock('@karmaniverous/jeeves', () => ({
  nowIso: () => '2026-10-04T00:00:00.000Z',
}));

import type { RunnerClient } from '@karmaniverous/jeeves-runner';

import {
  getThreadState,
  loadScalarState,
  saveScalarState,
  seenKey,
  setThreadState,
} from './email-state.js';

const ACCOUNT = 'me@example.com';

function store() {
  const state = new Map<string, string>();
  const items = new Map<string, string>();
  const client = {
    getState: (ns: string, key: string) => state.get(`${ns}|${key}`) ?? null,
    setState: (ns: string, key: string, v: string) => {
      state.set(`${ns}|${key}`, v);
    },
    getItem: (ns: string, key: string, id: string) =>
      items.get(`${ns}|${key}|${id}`) ?? null,
    setItem: (ns: string, key: string, id: string, v?: string) => {
      items.set(`${ns}|${key}|${id}`, v ?? '');
    },
  } satisfies Pick<
    RunnerClient,
    'getState' | 'setState' | 'getItem' | 'setItem'
  >;
  return { client, state, items };
}

describe('thread state', () => {
  it('round-trips under email/<account>.seenThreadIds', () => {
    const { client, items } = store();
    expect(getThreadState(client, ACCOUNT, 't1')).toBeNull();
    setThreadState(client, ACCOUNT, 't1', { bucket: 'A', labels: ['INBOX'] });
    expect(seenKey(ACCOUNT)).toBe(`${ACCOUNT}.seenThreadIds`);
    expect(items.has(`email|${ACCOUNT}.seenThreadIds|t1`)).toBe(true);
    expect(getThreadState(client, ACCOUNT, 't1')).toEqual({
      bucket: 'A',
      labels: ['INBOX'],
    });
  });

  it('throws on an old-format (bare string) item', () => {
    const { client, items } = store();
    items.set(`email|${ACCOUNT}.seenThreadIds|t1`, '2026-01-01T00:00:00Z');
    expect(() => getThreadState(client, ACCOUNT, 't1')).toThrow(SyntaxError);
  });
});

describe('scalar state', () => {
  it('defaults when absent and stamps updatedAt on save', () => {
    const { client, state } = store();
    const s = loadScalarState(ACCOUNT, client);
    expect(s).toEqual({ account: ACCOUNT, updatedAt: null });
    saveScalarState(s, client);
    expect(JSON.parse(state.get(`email|${ACCOUNT}.state`)!)).toEqual({
      account: ACCOUNT,
      updatedAt: '2026-10-04T00:00:00.000Z',
    });
    expect(loadScalarState(ACCOUNT, client)).toEqual({
      account: ACCOUNT,
      updatedAt: '2026-10-04T00:00:00.000Z',
    });
  });
});
