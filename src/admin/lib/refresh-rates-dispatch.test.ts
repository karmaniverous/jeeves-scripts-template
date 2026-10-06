import { describe, expect, it, vi } from 'vitest';

const readWorkerFinalText =
  vi.fn<(stdout: string, rpc: unknown) => Promise<string | null>>();
vi.mock('../../lib/worker-output.js', () => ({
  readWorkerFinalText: (stdout: string, rpc: unknown) =>
    readWorkerFinalText(stdout, rpc),
}));

import { gatewayInvoke } from '../../lib/gateway-client.js';
import { gatewayRpc } from '../../lib/gateway-rpc.js';
import {
  defaultRefreshDispatchDeps,
  dispatchRefreshWorker,
  REFRESH_DISPATCH_OPTIONS,
  type RefreshDispatchDeps,
} from './refresh-rates-dispatch.js';

function deps(exitCode: number): RefreshDispatchDeps {
  return {
    dispatch: vi.fn<RefreshDispatchDeps['dispatch']>(() =>
      Promise.resolve({ exitCode, stdout: 'worker stdout' }),
    ),
    rpc: defaultRefreshDispatchDeps.rpc,
  };
}

describe('dispatchRefreshWorker', () => {
  it('reads the reply through the gateway RPC transport, not tools-invoke (#92)', () => {
    expect(defaultRefreshDispatchDeps.rpc).toBe(gatewayRpc);
    expect(defaultRefreshDispatchDeps.rpc).not.toBe(gatewayInvoke);
  });

  it('dispatches the task and reads the final reply on success', async () => {
    readWorkerFinalText.mockResolvedValueOnce('RESULT: unchanged');
    const d = deps(0);
    await expect(dispatchRefreshWorker('TASK', d)).resolves.toEqual({
      exitCode: 0,
      finalText: 'RESULT: unchanged',
    });
    expect(d.dispatch).toHaveBeenCalledWith(
      'TASK',
      REFRESH_DISPATCH_OPTIONS,
      expect.any(String),
    );
    expect(readWorkerFinalText).toHaveBeenCalledWith(
      'worker stdout',
      gatewayRpc,
    );
  });

  it('does not read a reply when the dispatch failed', async () => {
    readWorkerFinalText.mockClear();
    await expect(dispatchRefreshWorker('TASK', deps(1))).resolves.toEqual({
      exitCode: 1,
      finalText: null,
    });
    expect(readWorkerFinalText).not.toHaveBeenCalled();
  });
});
