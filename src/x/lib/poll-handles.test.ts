import { afterEach, describe, expect, it, vi } from 'vitest';

import { logPollHandles, resolvePollHandles } from './poll-handles.js';

const accounts = { alice: '/data/x/alice', bob: '/data/x/bob' };
const all = () => true;

describe('resolvePollHandles', () => {
  it('polls every configured handle when no handle is given', () => {
    expect(resolvePollHandles(undefined, accounts, all)).toEqual({
      handles: ['alice', 'bob'],
      skipped: [],
    });
  });

  it('narrows to the handle argument', () => {
    expect(resolvePollHandles('bob', accounts, all).handles).toEqual(['bob']);
  });

  it('skips handles without an OAuth file', () => {
    expect(resolvePollHandles(undefined, accounts, (h) => h === 'bob')).toEqual(
      {
        handles: ['bob'],
        skipped: [
          { handle: 'alice', reason: 'X OAuth2 credentials not configured' },
        ],
      },
    );
  });

  it('skips a handle argument that is not in X_ACCOUNTS (never drained)', () => {
    expect(resolvePollHandles('carol', accounts, all)).toEqual({
      handles: [],
      skipped: [{ handle: 'carol', reason: 'not configured in X_ACCOUNTS' }],
    });
  });

  it('does not treat inherited object keys as configured handles', () => {
    expect(resolvePollHandles('toString', accounts, all).handles).toEqual([]);
  });

  it('reports not configured when X_ACCOUNTS is empty', () => {
    const r = resolvePollHandles(undefined, {}, all);
    expect(r.handles).toEqual([]);
    expect(r.notConfigured).toMatch(/no X accounts configured in X_ACCOUNTS/);
  });
});

describe('logPollHandles', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs a [skip] line per skipped handle and returns the rest', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(
      logPollHandles({
        handles: ['bob'],
        skipped: [{ handle: 'alice', reason: 'why' }],
      }),
    ).toEqual(['bob']);
    expect(log.mock.calls).toEqual([['[skip] @alice: why']]);
  });

  it('logs the not-configured reason', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(
      logPollHandles({ handles: [], skipped: [], notConfigured: 'nothing' }),
    ).toEqual([]);
    expect(log.mock.calls).toEqual([['[skip] nothing']]);
  });
});
