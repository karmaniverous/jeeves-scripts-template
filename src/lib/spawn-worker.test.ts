import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type GatewaySession,
  getTokensFromTranscript,
  isSessionCompleted,
  parseArgs,
  parseResultLine,
  type WaitDeps,
  waitForWorkerCompletion,
} from './spawn-worker.js';

describe('parseArgs', () => {
  it('parses --key=value pairs', () => {
    const result = parseArgs(['--job-id=abc123', '--label=test']);
    expect(result).toEqual({
      'job-id': 'abc123',
      label: 'test',
    });
  });

  it('ignores non-flag arguments', () => {
    const result = parseArgs(['positional', '--key=val', 'another']);
    expect(result).toEqual({ key: 'val' });
  });

  it('handles empty value', () => {
    const result = parseArgs(['--key=']);
    expect(result).toEqual({ key: '' });
  });

  it('handles value with equals sign', () => {
    const result = parseArgs(['--key=a=b']);
    expect(result).toEqual({ key: 'a=b' });
  });

  it('returns empty object for no args', () => {
    expect(parseArgs([])).toEqual({});
  });
});

describe('isSessionCompleted', () => {
  const row = (status?: string) => ({ key: 'k', status });

  it('is running while the row is missing or has no status', () => {
    expect(isSessionCompleted(undefined)).toEqual({ completed: false });
    expect(isSessionCompleted(row())).toEqual({ completed: false });
  });

  it('is running while status is running, however long it has been quiet', () => {
    const quiet = { ...row('running'), updatedAt: Date.now() - 600_000 };
    expect(isSessionCompleted(quiet)).toEqual({ completed: false });
  });

  it('is completed when status is done', () => {
    expect(isSessionCompleted(row('done'))).toEqual({ completed: true });
  });

  it.each(['failed', 'killed', 'timeout'])('fails on status %s', (status) => {
    expect(isSessionCompleted(row(status))).toEqual({
      completed: true,
      error: `Worker run ended: status=${status}`,
    });
  });
});

describe('waitForWorkerCompletion', () => {
  /** Fake clock + scripted rows; each poll advances time by the sleep. */
  function harness(rows: (GatewaySession | undefined)[]): WaitDeps {
    let clock = 0;
    let poll = 0;
    return {
      findSession: () =>
        Promise.resolve(rows[Math.min(poll++, rows.length - 1)]),
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      now: () => clock,
      tokensFor: (s) => s.totalTokens ?? 0,
    };
  }

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('keeps waiting through >60 s of silence, then returns on done', async () => {
    // Last update at t=0; the worker writes its reply for ~100 s (20 polls).
    const writing = { key: 'k', status: 'running', updatedAt: 0 };
    const done = { key: 'k', status: 'done', totalTokens: 42, model: 'm' };
    const rows = [...Array<GatewaySession>(20).fill(writing), done];
    const result = await waitForWorkerCompletion('k', 0, harness(rows));
    expect(result).toEqual({
      success: true,
      durationMs: 3000 + 20 * 5000,
      tokens: 42,
      model: 'm',
    });
  });

  it('tolerates poll errors and a not-yet-listed row', async () => {
    const deps = harness([undefined, { key: 'k', status: 'done' }]);
    const find = deps.findSession;
    let first = true;
    deps.findSession = (key) => {
      if (first) {
        first = false;
        return Promise.reject(new Error('gateway down'));
      }
      return find(key);
    };
    await expect(waitForWorkerCompletion('k', 0, deps)).resolves.toEqual(
      expect.objectContaining({ success: true }),
    );
  });

  it.each(['failed', 'timeout'])(
    'throws when the run ends with status %s',
    async (status) => {
      const running = { key: 'k', status: 'running' };
      const deps = harness([running, { key: 'k', status }]);
      await expect(waitForWorkerCompletion('k', 0, deps)).rejects.toThrow(
        `Worker run ended: status=${status}`,
      );
    },
  );
});

describe('parseResultLine', () => {
  it('parses valid WORKER_RESULT line', () => {
    const line =
      'WORKER_RESULT:{"sessionKey":"abc","tokens":100,"durationMs":5000}';
    expect(parseResultLine(line)).toEqual({
      sessionKey: 'abc',
      tokens: 100,
      durationMs: 5000,
    });
  });

  it('parses line with model', () => {
    const line =
      'WORKER_RESULT:{"sessionKey":"abc","tokens":100,"durationMs":5000,"model":"claude-3"}';
    expect(parseResultLine(line)).toEqual({
      sessionKey: 'abc',
      tokens: 100,
      durationMs: 5000,
      model: 'claude-3',
    });
  });

  it('returns null for non-WORKER_RESULT line', () => {
    expect(parseResultLine('some log line')).toBeNull();
  });

  it('returns null for invalid JSON after prefix', () => {
    expect(parseResultLine('WORKER_RESULT:{broken')).toBeNull();
  });

  it('returns null for JSON missing required fields', () => {
    expect(parseResultLine('WORKER_RESULT:{"foo":"bar"}')).toBeNull();
  });
});

describe('getTokensFromTranscript', () => {
  it('returns 0 for non-existent file', () => {
    expect(getTokensFromTranscript('/nonexistent/path.jsonl')).toBe(0);
  });
});
